import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { needs, test } from "@openwork/testkit";

const fixture = fileURLToPath(new URL("../fixtures/mcp_release_security_test.py", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));

for (const method of [
  "test_fingerprints_match_across_exporter_and_witness",
  "test_export_persists_only_boolean_checks_and_redacted_witnesses",
  "test_proxy_enforces_tls12_even_with_permissive_runtime_defaults",
  "test_oauth_redirect_rejects_response_splitting_and_controls",
  "test_oauth_challenge_rejects_folded_host",
  "test_oauth_and_provider_positive_and_negative_controls",
  "test_proxy_rejects_invalid_upstream_header_names_and_values",
  "test_proxy_preserves_valid_headers_and_recomputes_content_length",
]) {
  test(`release fixture security: ${method}`, ({ evidence }) => {
    needs({ commands: ["python3"], placement: "local" });
    const result = spawnSync("python3", ["-B", fixture, `ReleaseSecurityTests.${method}`, "-v"], {
      cwd: root, encoding: "utf8", timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("Ran 1 test");
    expect(result.stderr).toContain("OK");
    evidence.recordAssertionEvidence(method, `python3 -B evals/fixtures/mcp_release_security_test.py ReleaseSecurityTests.${method} -v\n${result.stderr.trim()}`, true);
  });
}
