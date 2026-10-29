import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

export interface AnalysisOptions {
  root: string;
  tokenFiles: string[];
  sourceDirs: string[];
  entries: Array<{ id: string; sources: string[] }>;
}

export interface TokenFinding {
  name: string;
  value: string;
  source: string;
  line: number;
  /** Selector and enclosing at-rules; declarations are never merged across themes. */
  context: string;
  consumers: string[];
}

export interface HardcodedFinding {
  source: string;
  line: number;
  value: string;
  kind: "color" | "px" | "duration";
}

export interface ScaleFinding {
  property: string;
  value: string;
  source: string;
  line: number;
  context?: string;
}

export interface AnalysisReport {
  tokens: TokenFinding[];
  hardcoded: HardcodedFinding[];
  coverage: { covered: string[]; uncovered: string[] };
  scales: {
    type: ScaleFinding[];
    spacing: ScaleFinding[];
    motion: ScaleFinding[];
  };
}

/** This is a source inventory, not a CSS cascade, typechecker or automatic fix list. */
export const ANALYSIS_HEURISTICS = [
  "CSS declarations and TS/JS style properties, raw CSS strings/templates and arbitrary Tailwind values are candidates; comments, URLs, tests and declaration files are ignored.",
  "Custom-property definitions are tokens, not hardcoded findings. Unit-zero values and transparent/currentColor are ignored. Named colors are inspected only in color-bearing properties.",
  "Consumers include var() references and declared Tailwind theme namespaces, propagated through token aliases; they indicate source references, not proven runtime use or cascade resolution.",
  "Coverage checks exporting TSX/JSX files against entry sources, excluding bootstraps with no exports; it is not runtime or branch coverage. Scales retain source observations rather than inventing a normalized design scale.",
] as const;

interface Declaration {
  property: string;
  value: string;
  start: number;
  valueStart: number;
  context: string;
}

const sourceExtension = /\.(?:[cm]?[jt]sx?|css)$/i;
const excludedFile = /(?:\.(?:test|spec|stories)\.[cm]?[jt]sx?|\.d\.[cm]?ts)$/i;
const ignoredDirectories = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".lab-artifacts",
]);
const portable = (file: string) => file.split(path.sep).join("/");
const lineAt = (text: string, offset: number) =>
  text.slice(0, offset).split("\n").length;
const mask = (text: string) => text.replace(/[^\r\n]/g, " ");

/** Preserve offsets, quotes and newlines while removing CSS comments. */
function withoutCssComments(text: string): string {
  let result = "";
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      result += char;
      if (char === "\\" && i + 1 < text.length) result += text[++i];
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
      result += char;
    } else if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      result += mask(text.slice(i, stop));
      i = stop - 1;
    } else result += char;
  }
  return result;
}

/** Small declaration scanner: delimiters in strings/functions do not split values. */
function cssDeclarations(input: string, offset = 0): Declaration[] {
  const text = withoutCssComments(input);
  const result: Declaration[] = [];
  const contexts: string[] = [];
  let start = 0;
  let quote = "";
  let depth = 0;
  const flush = (end: number) => {
    const segment = text.slice(start, end);
    const match = /^(\s*)(--[\w-]+|[a-zA-Z][\w-]*)\s*:\s*([\s\S]*?)\s*$/.exec(
      segment,
    );
    if (!match || !match[3]) return;
    const colon = segment.indexOf(":", match[1].length + match[2].length);
    const leadingValue = /^\s*/.exec(segment.slice(colon + 1))![0].length;
    result.push({
      property: match[2],
      value: match[3],
      start: offset + start + match[1].length,
      valueStart: offset + start + colon + 1 + leadingValue,
      context: contexts.join(" > ") || "inline",
    });
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[") {
      depth++;
      continue;
    }
    if (char === ")" || char === "]") {
      depth--;
      continue;
    }
    if (depth > 0) continue;
    if (char === "{") {
      contexts.push(text.slice(start, i).trim().replace(/\s+/g, " "));
      start = i + 1;
    } else if (char === ";" || char === "}") {
      flush(i);
      if (char === "}") contexts.pop();
      start = i + 1;
    }
  }
  flush(text.length);
  return result;
}

function cssProperty(name: string): string {
  return name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function isStyleProperty(property: string): boolean {
  return /^(?:--|(?:background|border|outline|box-shadow|text-shadow|color|fill|stroke|stop-color|caret|accent|font|line-height|letter-spacing|word-spacing|text-decoration|margin|padding|gap|row-gap|column-gap|width|height|min-width|max-width|min-height|max-height|inset|top|right|bottom|left|flex-basis|transform|translate|rotate|scale|perspective|filter|backdrop-filter|transition|animation|duration|delay|ease|scroll-margin|scroll-padding)(?:-|$))/.test(
    property,
  );
}

function scaleKind(
  property: string,
): keyof AnalysisReport["scales"] | undefined {
  if (
    /^(?:font(?:-|$)|line-height$|letter-spacing$|word-spacing$|--(?:font|text|type|leading|tracking)(?:-|$))/.test(
      property,
    )
  )
    return "type";
  if (
    /^(?:(?:margin|padding|gap|row-gap|column-gap|inset|border-radius|scroll-margin|scroll-padding)(?:-|$)|--(?:space|spacing|gap|radius|size)(?:-|$))/.test(
      property,
    )
  )
    return "spacing";
  if (
    /^(?:transition|animation|duration|delay|ease|--(?:duration|delay|ease|easing|motion|transition|animation))(?:-|$)/.test(
      property,
    )
  )
    return "motion";
  return undefined;
}

function utilityProperty(utility: string, value: string): string {
  if (utility === "text")
    return /^(?:-?[\d.]|length:)/.test(value) ? "font-size" : "color";
  const properties: Record<string, string> = {
    bg: "background",
    duration: "transition-duration",
    delay: "transition-delay",
    ease: "transition-timing-function",
    leading: "line-height",
    tracking: "letter-spacing",
    rounded: "border-radius",
    font: /^\d/.test(value) ? "font-weight" : "font-family",
  };
  if (properties[utility]) return properties[utility];
  if (/^p[xytrblse]?$/.test(utility)) return "padding";
  if (/^m[xytrblse]?$/.test(utility)) return "margin";
  if (/^gap(?:-[xy])?$/.test(utility)) return "gap";
  return utility;
}

const colorNames = new Set(
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(
    " ",
  ),
);

function literalFindings(
  value: string,
  property: string,
): Array<{ index: number; value: string; kind: HardcodedFinding["kind"] }> {
  const results: Array<{
    index: number;
    value: string;
    kind: HardcodedFinding["kind"];
  }> = [];
  // URL fragments, file dimensions and data-URI colors are not style literals.
  const text = withoutCssComments(value).replace(
    /url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)|https?:\/\/[^\s"']+/gi,
    mask,
  );
  const colorFunction =
    /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\s*\(/gi;
  const colorRanges: Array<[number, number]> = [];
  for (let match; (match = colorFunction.exec(text)); ) {
    let end = colorFunction.lastIndex;
    let depth = 1;
    while (end < text.length && depth) {
      if (text[end] === "(") depth++;
      if (text[end] === ")") depth--;
      end++;
    }
    if (depth) continue;
    results.push({
      index: match.index,
      value: value.slice(match.index, end),
      kind: "color",
    });
    colorRanges.push([match.index, end]);
    colorFunction.lastIndex = end;
  }
  for (const match of text.matchAll(/#[\da-f]+\b/gi)) {
    if (
      ![4, 5, 7, 9].includes(match[0].length) ||
      colorRanges.some(([a, b]) => match.index! >= a && match.index! < b)
    )
      continue;
    results.push({ index: match.index!, value: match[0], kind: "color" });
  }
  for (const match of text.matchAll(
    /(?<![\w.-])(-?(?:\d+(?:\.\d*)?|\.\d+))(px|ms|s)\b/gi,
  )) {
    if (Number(match[1]) === 0) continue;
    results.push({
      index: match.index!,
      value: match[0],
      kind: match[2].toLowerCase() === "px" ? "px" : "duration",
    });
  }
  if (
    /(?:color|background|border|outline|shadow|fill|stroke|gradient)/.test(
      property,
    )
  ) {
    // Mask var names so var(--red) is not mistaken for the named color red.
    const namedText = text.replace(/--[\w-]+/g, mask);
    for (const match of namedText.matchAll(/\b[a-z]+\b/gi)) {
      if (
        colorNames.has(match[0].toLowerCase()) &&
        !colorRanges.some(([a, b]) => match.index! >= a && match.index! < b)
      ) {
        results.push({ index: match.index!, value: match[0], kind: "color" });
      }
    }
  }
  return results.sort((a, b) => a.index - b.index);
}

/** Includes literal portions of template expressions, without evaluating project code. */
function scriptStrings(
  file: ts.SourceFile,
  text: string,
): Array<{ text: string; start: number; node: ts.Node }> {
  const result: Array<{ text: string; start: number; node: ts.Node }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      result.push({
        text: text.slice(node.getStart(file) + 1, node.end - 1),
        start: node.getStart(file) + 1,
        node,
      });
    } else if (ts.isTemplateExpression(node)) {
      const start = node.getStart(file) + 1;
      const end = node.end - 1;
      let value = text.slice(start, end);
      for (const span of node.templateSpans) {
        const holeStart = span.expression.pos - 2;
        const holeEnd = span.literal.getStart(file) + 1;
        const a = Math.max(0, holeStart - start);
        const b = Math.min(value.length, holeEnd - start);
        value = value.slice(0, a) + mask(value.slice(a, b)) + value.slice(b);
      }
      result.push({ text: value, start, node });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return result;
}

function propertyOf(node: ts.Node): string | undefined {
  let value = node;
  while (
    ts.isParenthesizedExpression(value.parent) ||
    ts.isAsExpression(value.parent) ||
    ts.isSatisfiesExpression(value.parent)
  )
    value = value.parent;
  const parent = value.parent;
  if (
    ts.isPropertyAssignment(parent) &&
    parent.initializer === value &&
    (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))
  )
    return cssProperty(parent.name.text);
  if (ts.isJsxAttribute(parent) && ts.isIdentifier(parent.name))
    return cssProperty(parent.name.text);
  if (
    ts.isJsxExpression(parent) &&
    parent.parent &&
    ts.isJsxAttribute(parent.parent) &&
    ts.isIdentifier(parent.parent.name)
  )
    return cssProperty(parent.parent.name.text);
  return undefined;
}

/** Resolve Tailwind utility namespaces only from tokens actually declared in the input. */
function themeClasses(name: string): string[] {
  const match =
    /^--(color|font|text|leading|tracking|spacing|radius|animate|ease)-(.+)$/.exec(
      name,
    );
  if (!match) return [];
  const [, namespace, suffix] = match;
  const prefixes: Record<string, string[]> = {
    color: [
      "bg",
      "text",
      "border",
      "border-x",
      "border-y",
      "border-t",
      "border-r",
      "border-b",
      "border-l",
      "ring",
      "ring-offset",
      "outline",
      "fill",
      "stroke",
      "shadow",
      "decoration",
      "caret",
      "accent",
      "from",
      "via",
      "to",
      "divide",
    ],
    font: ["font"],
    text: ["text"],
    leading: ["leading"],
    tracking: ["tracking"],
    spacing: [
      "p",
      "px",
      "py",
      "pt",
      "pr",
      "pb",
      "pl",
      "ps",
      "pe",
      "m",
      "mx",
      "my",
      "mt",
      "mr",
      "mb",
      "ml",
      "ms",
      "me",
      "gap",
      "gap-x",
      "gap-y",
      "w",
      "h",
      "size",
      "inset",
      "top",
      "left",
      "bottom",
      "right",
      "space-x",
      "space-y",
    ],
    radius: ["rounded", "rounded-t", "rounded-r", "rounded-b", "rounded-l"],
    animate: ["animate"],
    ease: ["ease"],
  };
  return prefixes[namespace].map((prefix) => `${prefix}-${suffix}`);
}

async function sourceFiles(root: string, inputs: string[]): Promise<string[]> {
  const files = new Set<string>();
  const walk = async (file: string): Promise<void> => {
    const info = await stat(file);
    if (!info.isDirectory()) {
      if (sourceExtension.test(file) && !excludedFile.test(file))
        files.add(file);
      return;
    }
    for (const entry of (await readdir(file, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      // Do not follow symlinks out of configured source roots or recurse through cycles.
      if (
        entry.isSymbolicLink() ||
        (entry.isDirectory() && ignoredDirectories.has(entry.name))
      )
        continue;
      await walk(path.join(file, entry.name));
    }
  };
  for (const input of inputs) await walk(path.resolve(root, input));
  return [...files].sort();
}

/** Analyze only caller-configured roots; never imports or executes consumer modules. */
export async function analyze(
  options: AnalysisOptions,
): Promise<AnalysisReport> {
  const root = path.resolve(options.root);
  const files = await sourceFiles(root, [
    ...options.tokenFiles,
    ...options.sourceDirs,
  ]);
  const report: AnalysisReport = {
    tokens: [],
    hardcoded: [],
    coverage: { covered: [], uncovered: [] },
    scales: { type: [], spacing: [], motion: [] },
  };
  const references = new Map<string, Set<string>>();
  const componentSources = new Set<string>();
  const stringsBySource = new Map<string, string[]>();
  const addReference = (name: string, source: string) => {
    if (!references.has(name)) references.set(name, new Set());
    references.get(name)!.add(source);
  };
  for (const file of files) {
    const source = portable(path.relative(root, file));
    const text = await readFile(file, "utf8");
    let declarations: Declaration[];
    let strings: string[];
    if (file.endsWith(".css")) {
      const clean = withoutCssComments(text);
      declarations = cssDeclarations(clean);
      strings = [clean];
    } else {
      const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      if (
        /\.[jt]sx$/i.test(file) &&
        ast.statements.some(
          (statement) =>
            ts.isExportAssignment(statement) ||
            ts.isExportDeclaration(statement) ||
            (ts.canHaveModifiers(statement) &&
              ts
                .getModifiers(statement)
                ?.some(
                  (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
                )),
        )
      )
        componentSources.add(source);
      const literals = scriptStrings(ast, text);
      strings = literals.map((item) => withoutCssComments(item.text));
      declarations = [];
      for (const literal of literals) {
        const property = propertyOf(literal.node);
        if (property && isStyleProperty(property)) {
          declarations.push({
            property,
            value: literal.text,
            start: literal.node.getStart(ast),
            valueStart: literal.start,
            context: "inline style",
          });
        } else if (
          /[{};]/.test(literal.text) &&
          /(?:^|[{};])\s*(?:--[\w-]+|[a-z-]+)\s*:/i.test(literal.text)
        ) {
          declarations.push(...cssDeclarations(literal.text, literal.start));
        }
        // Arbitrary utilities have explicit syntax, unlike ordinary prose or identifiers.
        for (const match of literal.text.matchAll(
          /(?:^|\s)(?:[\w-]+:)*([\w-]+)-\[([^\]\r\n]+)\]/g,
        )) {
          declarations.push({
            property: utilityProperty(match[1], match[2]),
            value: match[2],
            start: literal.start + match.index!,
            valueStart:
              literal.start + match.index! + match[0].indexOf("[") + 1,
            context: "arbitrary utility",
          });
        }
      }
      const numericScales = (node: ts.Node) => {
        if (ts.isNumericLiteral(node)) {
          const property = propertyOf(node);
          if (property && scaleKind(property))
            declarations.push({
              property,
              value: node.text,
              start: node.getStart(ast),
              valueStart: node.getStart(ast),
              context: "inline style",
            });
        }
        ts.forEachChild(node, numericScales);
      };
      numericScales(ast);
    }
    stringsBySource.set(source, strings);
    for (const value of strings)
      for (const match of value.matchAll(/\bvar\(\s*(--[\w-]+)/g))
        addReference(match[1], source);
    for (const declaration of declarations) {
      const { property, value, start, valueStart, context } = declaration;
      const line = lineAt(text, start);
      if (property.startsWith("--"))
        report.tokens.push({
          name: property,
          value,
          source,
          line,
          context,
          consumers: [],
        });
      else
        for (const finding of literalFindings(value, property))
          report.hardcoded.push({
            source,
            line: lineAt(text, valueStart + finding.index),
            value: finding.value,
            kind: finding.kind,
          });
      const kind = scaleKind(property);
      if (kind)
        report.scales[kind].push({ property, value, source, line, context });
    }
  }

  // Derive class-to-token associations from @theme namespaces, not a product registry.
  const utilities = new Map<string, Set<string>>();
  for (const token of report.tokens)
    for (const utility of themeClasses(token.name)) {
      if (!utilities.has(utility)) utilities.set(utility, new Set());
      utilities.get(utility)!.add(token.name);
    }
  for (const [source, strings] of stringsBySource)
    for (const value of strings) {
      for (const match of value.matchAll(/[\w!:/.-]+/g)) {
        const utility = match[0]
          .split(":")
          .pop()!
          .replace(/^!|-?\/$/g, "")
          .split("/")[0];
        for (const name of utilities.get(utility) ?? [])
          addReference(name, source);
      }
    }
  // A source using --color-primary also consumes the --primary alias it resolves to.
  let changed = true;
  while (changed) {
    changed = false;
    for (const token of report.tokens)
      for (const match of withoutCssComments(token.value).matchAll(
        /\bvar\(\s*(--[\w-]+)/g,
      )) {
        for (const consumer of references.get(token.name) ?? []) {
          const count = references.get(match[1])?.size ?? 0;
          addReference(match[1], consumer);
          if (references.get(match[1])!.size !== count) changed = true;
        }
      }
  }
  for (const token of report.tokens)
    token.consumers = [...(references.get(token.name) ?? [])].sort();
  const covered = new Set(
    options.entries.flatMap((entry) =>
      entry.sources.map((source) =>
        portable(path.relative(root, path.resolve(root, source))),
      ),
    ),
  );
  for (const source of [...componentSources].sort())
    report.coverage[covered.has(source) ? "covered" : "uncovered"].push(source);
  // Multiple style representations on the same source line should not repeat a finding.
  report.hardcoded = [
    ...new Map(
      report.hardcoded.map((item) => [
        `${item.source}:${item.line}:${item.kind}:${item.value}`,
        item,
      ]),
    ).values(),
  ];
  return report;
}

// Browser consumers import ./contrast directly, without this module's filesystem scanner.
export { contrastRatio, type Rgb } from "./contrast.ts";
