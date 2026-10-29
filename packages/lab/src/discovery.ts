import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import {
  fail,
  isSlug,
  kinds,
  validateControls,
  validateMeta,
  validateRegistry,
  validateValues,
  type Control,
  type EntryMeta,
  type RegistryRecord,
} from "./schema.ts";

export interface DiscoveredEntry extends RegistryRecord {
  meta: EntryMeta;
  controls: Record<string, Control>;
  /** Absolute, verified paths; entry identity is always meta.id, never a user path. */
  directory: string;
  file: string;
}
export function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
}
/** Reject symlinks at every existing component, not just at the final file. */
export async function assertConfined(
  root: string,
  target: string,
  allowMissing = false,
): Promise<void> {
  if (!isInside(root, target)) fail(`Path escapes workspace: ${target}`);
  const segments = relative(root, target).split(sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < segments.length; index++) {
    current = join(current, segments[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT")
        return;
      throw error;
    }
    if (info.isSymbolicLink())
      fail(`Symlink paths are not allowed: ${current}`);
    if (index < segments.length - 1 && !info.isDirectory())
      fail(`Not a directory: ${current}`);
  }
}
function unwrap(node: ts.Expression): ts.Expression {
  while (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isTypeAssertionExpression(node)
  )
    node = node.expression;
  return node;
}
function literal(node: ts.Expression, label: string, depth = 0): unknown {
  if (depth > 20) fail(`${label}: literal is too deeply nested`);
  node = unwrap(node);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.MinusToken ||
      node.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(node.operand)
  ) {
    return (
      Number(node.operand.text) *
      (node.operator === ts.SyntaxKind.MinusToken ? -1 : 1)
    );
  }
  if (ts.isArrayLiteralExpression(node))
    return node.elements.map((item) => literal(item, label, depth + 1));
  if (ts.isObjectLiteralExpression(node)) {
    const result: Record<string, unknown> = Object.create(null);
    for (const property of node.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))
      )
        fail(
          `${label}: only literal object properties are allowed (no spreads, computed fields or references)`,
        );
      const key = property.name.text;
      if (Object.hasOwn(result, key))
        fail(`${label}: duplicate literal property ${key}`);
      if (["__proto__", "constructor", "prototype"].includes(key))
        fail(`${label}: unsafe literal property ${key}`);
      result[key] = literal(property.initializer, `${label}.${key}`, depth + 1);
    }
    return result;
  }
  return fail(
    `${label} must be JSON-compatible literal data; product modules are never executed during discovery`,
  );
}
function exportedLiteral(source: ts.SourceFile, name: string): unknown {
  const declarations: ts.VariableDeclaration[] = [];
  for (const statement of source.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
    )
      continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        if (!(statement.declarationList.flags & ts.NodeFlags.Const))
          fail(
            `${source.fileName}: ${name} must be exported const literal data`,
          );
        declarations.push(declaration);
      }
    }
  }
  if (declarations.length !== 1 || !declarations[0].initializer)
    fail(`${source.fileName}: export exactly one literal const ${name}`);
  return literal(declarations[0].initializer, `${source.fileName}: ${name}`);
}
/** Statically validate inline story/variant identities without touching render functions. */
function validateInlineStories(
  source: ts.SourceFile,
  controls: Record<string, Control>,
): void {
  const defaultExport = source.statements.find(
    (node): node is ts.ExportAssignment =>
      ts.isExportAssignment(node) && !node.isExportEquals,
  );
  if (!defaultExport) fail(`${source.fileName}: missing default entry export`);
  const expression = unwrap(defaultExport.expression);
  if (!ts.isCallExpression(expression) || !expression.arguments[0]) return; // Runtime defineEntry handles factored definitions.
  const definition = unwrap(expression.arguments[0]);
  if (!ts.isObjectLiteralExpression(definition)) return;
  for (const field of ["stories", "variants"]) {
    const property = definition.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) &&
        ts.isIdentifier(p.name) &&
        p.name.text === field,
    );
    if (!property) {
      if (field === "stories") fail(`${source.fileName}: entry needs stories`);
      else continue;
    }
    const items = unwrap(property.initializer);
    if (!ts.isArrayLiteralExpression(items)) continue;
    if (field === "stories" && !items.elements.length)
      fail(`${source.fileName}: entry needs stories`);
    const ids = new Set<string>();
    for (const item of items.elements) {
      if (!ts.isObjectLiteralExpression(item)) continue;
      const props = new Map(
        item.properties
          .filter(ts.isPropertyAssignment)
          .filter((p) => ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
          .map((p) => [(p.name as ts.Identifier).text, p.initializer]),
      );
      const id = props.has("id")
        ? literal(props.get("id")!, `${field}.id`)
        : undefined;
      if (!isSlug(id) || ids.has(id))
        fail(
          `${source.fileName}: invalid or duplicate ${field} id ${String(id)}`,
        );
      ids.add(id);
      const title = props.has("title")
        ? literal(props.get("title")!, `${field}.title`)
        : undefined;
      if (typeof title !== "string" || !title.trim())
        fail(`${source.fileName}: ${field} needs a title`);
      if (field === "variants") {
        if (!props.has("values"))
          fail(`${source.fileName}: variant needs values`);
        validateValues(
          literal(props.get("values")!, "variant.values"),
          controls,
        );
      } else if (!props.has("render"))
        fail(`${source.fileName}: story needs render`);
    }
  }
}
export async function discover(
  root: string,
  entriesDir: string,
): Promise<DiscoveredEntry[]> {
  const workspace = await realpath(resolve(root));
  const entries = resolve(workspace, entriesDir);
  await assertConfined(workspace, entries);
  if (!(await lstat(entries)).isDirectory())
    fail(`Entries path is not a directory: ${entriesDir}`);
  const files: string[] = [];
  let visited = 0;
  async function scan(directory: string, depth = 0): Promise<void> {
    if (depth > 20 || ++visited > 20000)
      fail("Entries directory is too large or deeply nested");
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, item.name);
      if (item.isSymbolicLink()) fail(`Symlink paths are not allowed: ${file}`);
      if (item.isDirectory()) await scan(file, depth + 1);
      else if (item.name === "entry.tsx") {
        if (!item.isFile()) fail(`Entry is not a regular file: ${file}`);
        files.push(file);
      }
    }
  }
  await scan(entries);
  const records: DiscoveredEntry[] = [];
  for (const file of files.sort()) {
    const parts = relative(entries, file).split(sep);
    if (
      parts.length !== 3 ||
      !kinds.includes(parts[0] as (typeof kinds)[number]) ||
      !isSlug(parts[1])
    )
      fail(
        `Misplaced entry ${file}; expected <kind>/<kebab-case-slug>/entry.tsx`,
      );
    await assertConfined(workspace, file);
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    );
    let content: string;
    try {
      const info = await handle.stat();
      if (!info.isFile()) fail(`Entry is not a regular file: ${file}`);
      if (info.size > 2 * 1024 * 1024) fail(`Entry file is too large: ${file}`);
      content = new TextDecoder("utf-8", { fatal: true }).decode(
        await handle.readFile(),
      );
    } finally {
      await handle.close();
    }
    const source = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const diagnostics = (
      source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }
    ).parseDiagnostics;
    if (diagnostics.length)
      fail(
        `${file}: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, "\n")}`,
      );
    const meta = validateMeta(exportedLiteral(source, "meta"));
    if (meta.id !== `${parts[0]}/${parts[1]}`)
      fail(`${file}: metadata id ${meta.id} does not match its path`);
    const controls = validateControls(exportedLiteral(source, "controls"));
    validateInlineStories(source, controls);
    for (const sourcePath of meta.sources) {
      const target = resolve(workspace, sourcePath);
      await assertConfined(workspace, target);
      if (!(await lstat(target)).isFile())
        fail(`${meta.id}: source is not a file: ${sourcePath}`);
    }
    records.push({ meta, controls, directory: resolve(file, ".."), file });
  }
  validateRegistry(records);
  return records;
}
