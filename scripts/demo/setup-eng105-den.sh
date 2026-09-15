#!/usr/bin/env bash
# Den >=0.18.43; bash 3.2+, curl, jq. Never pass credentials as arguments.
# stdout: JSON receipts array. stderr: table/diff/manual steps. No OAuth is started.
# Env: DEN_API_URL, DEN_API_KEY; optional DEMO_KEY_PREFIX, DEMO_STATE_DIR,
# DEMO_EXPECTED_ORG_ID, DEMO_TEAMMATE_EMAIL, DEMO_HOME_URL, DEMO_CLOCKS_URL,
# DEMO_CALENDAR_URL, DEMO_CALENDAR_ISSUER, DEMO_CALENDAR_SCOPES (JSON array).
# Keep the SAME owner-only state directory across apply/verify/teardown.
set +x
set -euo pipefail
umask 077
MODE=apply
CONNECTIONS_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --apply) MODE=apply ;;
    --verify) MODE=verify ;;
    --teardown) MODE=teardown ;;
    --connections-only) CONNECTIONS_ONLY=true ;;
    --help) printf '%s\n' 'Usage: setup-eng105-den.sh [--apply|--verify|--teardown] [--connections-only]' 'Credentials: environment DEN_API_URL + DEN_API_KEY only. Keep DEMO_STATE_DIR for safe teardown.'; exit 0 ;;
    *) printf '%s\n' 'Unknown argument; credentials are accepted only through environment.' >&2; exit 2 ;;
  esac
done
for cmd in curl jq; do command -v "$cmd" >/dev/null || exit 2; done
: "${DEN_API_URL:?Set DEN_API_URL}"
: "${DEN_API_KEY:?Set DEN_API_KEY}"
DEN_API_URL=${DEN_API_URL%/}
# Prevent curl config/header injection and URL credentials/query-string leakage.
[[ "$DEN_API_KEY" != *[$'\r\n"\\']* ]] || exit 2
[[ "$DEN_API_URL" =~ ^https?://[a-zA-Z0-9.:-]+$ ]] || exit 2
case "$DEN_API_URL" in https://*|http://127.0.0.1:*|http://localhost:*) ;; *) exit 2 ;; esac
PREFIX=${DEMO_KEY_PREFIX:-}
[[ -z "$PREFIX" || "$PREFIX" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || exit 2
[[ ${#PREFIX} -le 100 ]] || exit 2
# Experiments set this explicitly; the script supports any authorized Den org.
EXPECTED_ORG=${DEMO_EXPECTED_ORG_ID:-}
STATE=${DEMO_STATE_DIR:-.eng105-den-state}
[[ ! -L "$STATE" ]] || exit 2
mkdir -p "$STATE"
[[ -d "$STATE" && -O "$STATE" ]] || exit 2
chmod 700 "$STATE"
MANIFEST="$STATE/owner.json"
[[ ! -L "$MANIFEST" ]] || exit 2
mkdir "$STATE/lock" 2>/dev/null || { printf 'State locked; inspect the owning process before removing stale lock.\n' >&2; exit 2; }
RECEIPTS='[]'
FAILED=0
finish() { local code=$?; trap - EXIT; printf '%s\n' "$RECEIPTS"; rmdir "$STATE/lock"; exit "$code"; }
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
fail() { printf '%s\n' "$1" >&2; FAILED=1; }
# Raw HTTP response exists only in process memory. No headers, URLs returned by OAuth,
# tokens, or curl diagnostics are persisted. Never follow redirects with admin headers.
request() {
  local key=$1 phase=$2 method=$3 path=$4 payload=${5:-} expected=${6:-200} raw rc=0
  local args=(--silent --max-time 90 --connect-timeout 10 --config - --request "$method" --write-out $'\n%{http_code}')
  [[ -z "$payload" ]] || args+=(--data-binary "$payload")
  raw=$(printf 'header = "x-api-key: %s"\nheader = "Content-Type: application/json"\n' "$DEN_API_KEY" | curl "${args[@]}" "$DEN_API_URL$path" 2>/dev/null) || rc=$?
  STATUS=${raw##*$'\n'}
  BODY=${raw%$'\n'*}
  [[ "$STATUS" =~ ^[0-9]{3}$ ]] || STATUS=000
  OK=false
  if [[ "$rc" == 0 && " $expected " == *" $STATUS "* ]]; then OK=true; fi
  local error=null id=null
  if [[ "$OK" == false ]]; then
    # Preserve structured error bodies apart from secret-bearing fields and strings.
    error=$(printf '%s' "$BODY" | jq -Rsc '
      def clean: walk(if type=="object" then with_entries(if (.key|test("token|secret|password|authorization|cookie|api.?key|invite.*url";"i")) then .value="[REDACTED]" else . end)
        elif type=="string" then (if (env.DEN_API_KEY|length)>0 then split(env.DEN_API_KEY)|join("[REDACTED]") else . end)
          |gsub("https?://[^\\s\\\"<>]+";"[URL REDACTED]")
          |gsub("(?i)(bearer|password|token|secret|api[_-]?key)[=: ]+[^ ,;\\s]+";"[REDACTED]") else . end);
      (try fromjson catch .)|clean')
    printf 'HTTP %s %s %s: %s\n' "$STATUS" "$method" "$path" "$error" >&2
  fi
  id=$(printf '%s' "$BODY" | jq -c '(.id // .item.id // .invitationId // null)' 2>/dev/null) || id=null
  RECEIPTS=$(jq -cn --argjson rows "$RECEIPTS" --arg key "$key" --arg phase "$phase" --arg url "$DEN_API_URL$path" --arg status "$STATUS" --argjson ok "$OK" --argjson id "$id" --argjson error "$error" --argjson curlExit "$rc" '$rows+[{key:$key,phase:$phase,url:$url,status:($status|tonumber),ok:$ok,connectionId:$id,errorBody:$error,curlExit:$curlExit}]')
}
save_manifest() {
  [[ ! -L "$MANIFEST.tmp" ]] || exit 2
  printf '%s\n' "$OWNED" > "$MANIFEST.tmp"
  mv "$MANIFEST.tmp" "$MANIFEST"
}
remember() {
  local kind=$1 key=$2 id=$3
  OWNED=$(jq -c --arg kind "$kind" --arg key "$key" --arg id "$id" '.resources += [{kind:$kind,key:$key,id:$id}] | .resources |= unique_by([.kind,.key,.id])' <<< "$OWNED")
  save_manifest
}
forget() {
  OWNED=$(jq -c --arg id "$1" '.resources |= map(select(.id!=$id))' <<< "$OWNED")
  save_manifest
}
request org identity GET /v1/org
[[ "$OK" == true ]] || exit 1
ORG=$(jq -er '.organization.id|strings|select(length>0)' <<< "$BODY")
ORG_BODY=$BODY
[[ -z "$EXPECTED_ORG" || "$ORG" == "$EXPECTED_ORG" ]] || { fail 'Organization mismatch: no mutation performed.'; exit 1; }
if [[ -f "$MANIFEST" ]]; then
  OWNED=$(jq -ce --arg api "$DEN_API_URL" --arg org "$ORG" --arg prefix "$PREFIX" 'select(.version==1 and .api==$api and .org==$org and .prefix==$prefix and (.resources|type)=="array")' "$MANIFEST") || { fail 'Owner manifest target mismatch; no mutation performed.'; exit 1; }
else
  OWNED=$(jq -cn --arg api "$DEN_API_URL" --arg org "$ORG" --arg prefix "$PREFIX" '{version:1,api:$api,org:$org,prefix:$prefix,resources:[]}')
  save_manifest
fi
request openapi discovery GET /openapi.json
[[ "$OK" == true ]] || exit 1
OPENAPI=$BODY
jq -e '.paths["/v1/mcp-connections/by-key/{externalKey}"].put' <<< "$OPENAPI" >/dev/null || { fail 'Required public MCP upsert API absent (Den >=0.18.43 required).'; exit 1; }
BY_KEY_GET=$(jq -r '.paths["/v1/mcp-connections/by-key/{externalKey}"].get != null' <<< "$OPENAPI")
PROBED=false
# Lookup is read-only; 404 is recorded as diagnostic, never relabelled GET success.
lookup() {
  local key=$1 id matches
  FOUND=null
  LOOKUP_METHOD=by-key
  if [[ "$BY_KEY_GET" == true || "$PROBED" == false ]]; then
    request "$key" lookup-by-key GET "/v1/mcp-connections/by-key/$key"
    if [[ "$STATUS" == 200 && "$OK" == true ]]; then
      jq -e --arg key "$key" '.externalKey==$key and (.id|type)=="string"' <<< "$BODY" >/dev/null || return 1
      FOUND=$BODY; return 0
    fi
    [[ "$STATUS" == 404 ]] || return 1
    PROBED=true
    if [[ "$BY_KEY_GET" == true ]]; then return 0; fi
  fi
  LOOKUP_METHOD=list-exact-externalKey-and-detail
  request "$key" lookup-list GET '/v1/mcp-connections?scope=manageable'
  [[ "$OK" == true ]] || return 1
  matches=$(jq -ce --arg key "$key" '[.connections[]|select(.externalKey==$key)]' <<< "$BODY") || return 1
  [[ $(jq length <<< "$matches") -le 1 ]] || return 1
  id=$(jq -r '.[0].id // empty' <<< "$matches")
  [[ -n "$id" ]] || return 0
  [[ "$id" =~ ^[a-zA-Z0-9_-]+$ ]] || return 1
  request "$key" lookup-detail GET "/v1/mcp-connections/$id"
  [[ "$OK" == true ]] || return 1
  jq -e --arg key "$key" --arg id "$id" '.id==$id and .externalKey==$key' <<< "$BODY" >/dev/null || return 1
  FOUND=$BODY
}
row() {
  local key=$1 obj=$2
  jq -r --arg key "$key" '[$key,.id,.authType,.credentialMode,.access.orgWide,(if has("connected") then .connected else "unknown" end)]|@tsv' <<< "$obj" >&2
  RECEIPTS=$(jq -cn --argjson rows "$RECEIPTS" --arg key "$key" --arg method "$LOOKUP_METHOD" --argjson o "$obj" '$rows+[{key:$key,phase:"verified-state",url:null,status:200,ok:true,connectionId:$o.id,errorBody:null,lookupMethod:$method,authType:$o.authType,credentialMode:$o.credentialMode,orgWide:$o.access.orgWide,connected:(if $o|has("connected") then $o.connected else "unknown" end)}]')
}
if [[ "$MODE" == teardown ]]; then
  # Dashboard removal comes first; never destroy a preexisting named dashboard.
  while IFS=$'\t' read -r kind key id; do
    [[ -n "$id" && "$id" =~ ^[a-zA-Z0-9_-]+$ ]] || continue
    if [[ "$kind" == mcp ]]; then
      case "$key" in "${PREFIX}acme-home-demo"|"${PREFIX}world-clocks-demo"|"${PREFIX}personal-calendar-demo") ;; *) fail 'Unexpected manifest key; preserved.'; continue ;; esac
      lookup "$key" || { fail 'Cleanup lookup failed; preserved.'; continue; }
      if [[ "$FOUND" == null ]]; then forget "$id"; continue; fi
      [[ $(jq -r .id <<< "$FOUND") == "$id" ]] || { fail 'Cleanup ID mismatch; preserved replacement.'; continue; }
      request "$key" teardown DELETE "/v1/mcp-connections/by-key/$key"
      if [[ "$OK" == true ]] && jq -e '.ok==true and .deleted==true' <<< "$BODY" >/dev/null; then forget "$id"; else fail 'MCP deletion not confirmed.'; fi
    elif [[ "$kind" == dashboard ]]; then
      request "$key" teardown-check GET "/v1/dashboards/$id" '' '200 404'
      if [[ "$STATUS" == 404 ]]; then forget "$id"; continue; fi
      if [[ "$OK" == true ]] && jq -e --arg id "$id" --arg name "$key" '.item.id==$id and .item.name==$name' <<< "$BODY" >/dev/null; then
        request "$key" teardown DELETE "/v1/dashboards/$id" '' 204
        if [[ "$OK" == true ]]; then forget "$id"; else fail 'Dashboard deletion failed.'; fi
      else fail 'Dashboard identity mismatch; preserved.'; fi
    elif [[ "$kind" == invitation ]]; then
      request "$key" teardown-invitation-check GET /v1/org
      if [[ "$OK" == true ]] && jq -e --arg id "$id" '[.invitations[]?|select(.id==$id and .status=="pending")]|length==1' <<< "$BODY" >/dev/null; then
        request "$key" teardown-invitation POST "/v1/invitations/$id/cancel"
        if [[ "$OK" == true ]]; then forget "$id"; else fail 'Invitation cancellation failed.'; fi
      else printf 'Preserved invitation: no longer demonstrably pending; never remove a member.\n' >&2; fi
    fi
  done < <(jq -r '.resources|sort_by(if .kind=="dashboard" then 0 else 1 end)[]|[.kind,.key,.id]|@tsv' <<< "$OWNED")
  exit "$FAILED"
fi
HOME_URL=${DEMO_HOME_URL:-https://acme-home-demo.vercel.app/mcp}
CLOCKS_URL=${DEMO_CLOCKS_URL:-https://world-clocks-six.vercel.app/mcp}
CALENDAR_URL=${DEMO_CALENDAR_URL:-https://personal-calendar-demo-mcp-app.vercel.app/mcp}
ISSUER=${DEMO_CALENDAR_ISSUER:-https://personal-calendar-demo-mcp-app.vercel.app}
SCOPES=${DEMO_CALENDAR_SCOPES:-'["calendar:read"]'}
jq -e 'type=="array" and all(.[];type=="string")' <<< "$SCOPES" >/dev/null || exit 2
CONNECTION_IDS='[]'
printf 'key\tid\tauthType\tcredentialMode\torgWide\tconnected\n' >&2
for base in acme-home-demo world-clocks-demo personal-calendar-demo; do
  key="$PREFIX$base"
  case "$base" in
    acme-home-demo) url=$HOME_URL; name='Acme Home'; auth=none; mode=shared ;;
    world-clocks-demo) url=$CLOCKS_URL; name='World Clocks'; auth=none; mode=shared ;;
    personal-calendar-demo) url=$CALENDAR_URL; name='Personal Calendar'; auth=oauth; mode=per_member ;;
  esac
  [[ "$url" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?/[^\?\#\@]*$ ]] || { fail 'Unsafe MCP URL.'; continue; }
  lookup "$key" || { fail 'Lookup failed; skipped mutation.'; continue; }
  before=$FOUND
  if [[ "$MODE" == apply ]]; then
    # Never migrate auth/issuer or rotate existing credentials implicitly.
    if [[ "$before" != null ]] && ! jq -e --arg auth "$auth" --arg mode "$mode" --arg url "$url" '.authType==$auth and .credentialMode==$mode and .url==$url' <<< "$before" >/dev/null; then
      fail "Existing connection identity/auth differs for $key; preserved."; continue
    fi
    if [[ "$before" != null && "$auth" == oauth ]] && ! jq -e --arg issuer "$ISSUER" --argjson scopes "$SCOPES" '.authorizationServerIssuer==$issuer and ((.requestedScopes // []|sort)==($scopes|sort))' <<< "$before" >/dev/null; then
      fail "Existing OAuth issuer/scopes differ for $key; preserved without rotation."; continue
    fi
    if [[ "$before" != null ]] && ! jq -e '.access|type=="object" and (.memberIds|type)=="array" and (.teamIds|type)=="array"' <<< "$before" >/dev/null; then
      fail 'Existing grants unavailable; refuse replacement rather than clear grants.'; continue
    fi
    access=$(jq -c 'if .==null then {orgWide:true,memberIds:[],teamIds:[]} else {orgWide:true,memberIds:.access.memberIds,teamIds:.access.teamIds} end' <<< "$before")
    payload=$(jq -cn --arg name "$PREFIX$name" --arg url "$url" --arg auth "$auth" --arg mode "$mode" --arg issuer "$ISSUER" --argjson scopes "$SCOPES" --argjson access "$access" '{name:$name,url:$url,authType:$auth,credentialMode:$mode,exposeDirectly:false,access:$access} + (if $auth=="oauth" then {authorizationServerIssuer:$issuer,requestedScopes:$scopes} else {} end)')
    request "$key" apply PUT "/v1/mcp-connections/by-key/$key" "$payload" '200 201'
    if [[ "$OK" != true ]]; then fail "Apply failed for $key."; continue; fi
    id=$(jq -er '.id|strings|select(length>0)' <<< "$BODY") || { fail 'Missing connection ID; inspect manually, never assume ownership.'; continue; }
    if [[ "$STATUS" == 201 && "$before" == null ]]; then remember mcp "$key" "$id"; fi
    if [[ "$before" != null && $(jq -r .id <<< "$before") != "$id" ]]; then fail 'ID changed unexpectedly; inspect manually.'; continue; fi
    changed=$(jq -cn --argjson before "$before" --argjson after "$BODY" '["name","url","authType","credentialMode","exposeDirectly","access","authorizationServerIssuer","requestedScopes"]|map(. as $k|select($before[$k]!=$after[$k]))')
    printf '%s HTTP%s stableId=%s changedFields=%s\n' "$key" "$STATUS" "$id" "$changed" >&2
    RECEIPTS=$(jq -cn --argjson rows "$RECEIPTS" --argjson changed "$changed" '$rows|.[-1].changedFields=$changed')
    lookup "$key" || { fail 'Post-apply read failed.'; continue; }
  fi
  if [[ "$FOUND" == null ]]; then fail "Missing $key."; continue; fi
  row "$key" "$FOUND"
  CONNECTION_IDS=$(jq -cn --argjson ids "$CONNECTION_IDS" --argjson found "$FOUND" '$ids+[{key:$found.externalKey,id:$found.id}]')
done
if [[ "$MODE" == verify || "$CONNECTIONS_ONLY" == true ]]; then
  printf 'MANUAL_STEP: Each member opens Your Connections > Personal Calendar > Connect. Registration is not OAuth readiness.\n' >&2
  exit "$FAILED"
fi
# Full API dashboard setup is deliberately separate from the UI demo world.
# The next checkpoint fills this public-API-only phase; no hidden UI/DB fallback.
printf 'MANUAL_STEP: Dashboard API setup pending script checkpoint; Den Web > Dashboards > Create dashboard > ENG105 API Demo > Add App (Acme Home, World Clocks, Personal Calendar) > Share > select named member > Viewer > Add. Each member: Your Connections > Personal Calendar > Connect.\n' >&2
exit "$FAILED"
