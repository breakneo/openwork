import ts from "typescript";
import { discoverWorlds } from "./world-plan.ts";

export function validateProofSpec(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (ast.parseDiagnostics.length) throw new Error(`${file}: invalid TypeScript syntax.`);
  const bindings = new Set(discoverWorlds(file, source).filter(world => world.binding !== "unknown").map(world => world.binding));
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "vitest") continue;
    const imports = statement.importClause?.namedBindings;
    if (imports && ts.isNamedImports(imports)) for (const item of imports.elements)
      if (["test", "it"].includes(item.propertyName?.text ?? item.name.text)) bindings.add(item.name.text);
  }
  let runnable = false;
  function visit(node) {
    if (ts.isCallExpression(node)) {
      let target = node.expression;
      const modifiers = [];
      while (ts.isPropertyAccessExpression(target) || ts.isCallExpression(target)) {
        if (ts.isPropertyAccessExpression(target)) modifiers.push(target.name.text);
        target = target.expression;
      }
      const callback = node.arguments.at(-1);
      if (ts.isIdentifier(target) && bindings.has(target.text) && !modifiers.some(value => ["skip", "todo"].includes(value))
        && callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
        && (!ts.isBlock(callback.body) || callback.body.statements.length > 0)) runnable = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!runnable) throw new Error(`${file}: add a nonempty test callback (testkit test/spec.world or Vitest test/it); empty, skip-only, and todo-only files cannot satisfy the proof contract.`);
}
