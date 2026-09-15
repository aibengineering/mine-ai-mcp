import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

/** Production imports relative to one module root, including whether they can run code. */
export function sourceImports(root: string, directory: string) {
  return readdirSync(join(root, directory), { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
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
