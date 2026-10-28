import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

/** Production imports relative to one module root, including whether they can run code. */
export function sourceImports(root: string, directory: string) {
  return readdirSync(join(root, directory), { recursive: true, encoding: "utf8" })
    // `*.test-support.ts` sits beside the tests it serves and is left out of the build like them.
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith(".test-support.ts"))
    .flatMap((file) => {
      const path = join(root, directory, file);
      const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
      return source.statements.flatMap((statement) => {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
        const clause = statement.importClause;
        const bindings = clause?.namedBindings;
        const typeOnly =
          clause?.isTypeOnly === true ||
          (!clause?.name &&
            bindings &&
            ts.isNamedImports(bindings) &&
            bindings.elements.every((item) => item.isTypeOnly));
        const specifier = statement.moduleSpecifier.text;
        const target = specifier.startsWith(".")
          ? relative(root, resolve(dirname(path), specifier)).replaceAll("\\", "/")
          : specifier;
        return [{ from: `${directory}/${file.replaceAll("\\", "/")}`, target, typeOnly }];
      });
    });
}

/**
 * A module's first-level folders and files, top layer first. A row may name
 * `*` for every entry no other row names. Code may import its own row or any
 * row below it, never one above.
 */
export type Layers = readonly (readonly string[])[];

/**
 * Every production import between a module's first-level entries that reaches
 * a higher layer, type imports included: a type filed upstairs still makes the
 * lower code read the upper. Entries no row names are reported too, so a new
 * folder has to be placed before it can import anything.
 */
export function layerViolations(root: string, layers: Layers): string[] {
  const rowOf = (entry: string) => {
    const row = layers.findIndex((names) => names.includes(entry));
    return row >= 0 ? row : layers.findIndex((names) => names.includes("*"));
  };
  const entryOf = (path: string) => relative(root, path).replaceAll("\\", "/").split("/")[0]!;
  const violations = new Set<string>();
  for (const file of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    const normalized = file.replaceAll("\\", "/");
    if (!normalized.endsWith(".ts") || /\.test(-support)?\.ts$/.test(normalized) || normalized.split("/").includes("test-support")) continue;
    const path = join(root, file);
    const from = entryOf(path);
    if (rowOf(from) < 0) {
      violations.add(`${from} is in no layer`);
      continue;
    }
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const specifiers: string[] = [];
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        specifiers.push(node.moduleSpecifier.text);
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal))
        specifiers.push(node.argument.literal.text);
      else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0]))
        specifiers.push(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(path), specifier);
      if (relative(root, target).startsWith("..")) continue;
      const to = entryOf(target.replace(/\.js$/, ".ts"));
      if (to === from) continue;
      if (rowOf(to) < 0) violations.add(`${to} is in no layer`);
      else if (rowOf(to) < rowOf(from)) violations.add(`${normalized} imports ${to}, a higher layer`);
    }
  }
  return [...violations].sort();
}
