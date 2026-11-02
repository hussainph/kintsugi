// Pulls user-visible text and eyebrow styling out of TS/TSX with the
// TypeScript parser (syntax only, no type checking).
import { createRequire } from 'node:module';
import { checkStyleString, positiveSpacing } from './rules.mjs';

const require = createRequire(import.meta.url);
let ts;
function typescript() {
  if (!ts) {
    try { ts = require('typescript'); } catch {
      throw new Error('lint:copy needs the typescript package. Run `pnpm install` first.');
    }
  }
  return ts;
}

// JSX props and object keys whose string value is shown to the person.
const TEXT_NAME = /^(?:title|label|placeholder|alt|description|heading|message|text|tooltip|hint|subtitle|caption|summary|empty|emptyText|error|body|detail|details|help|blurb|note|confirm|cancel|question|reason|why|lede|intro|headline|headerTitle|headerBackTitle|accessibilityLabel|accessibilityHint|aria-label|aria-description|aria-placeholder|aria-roledescription|aria-valuetext)$|(?:Label|Title|Text|Message|Hint|Placeholder|Description|Copy|Caption|Heading|Summary|Tooltip|Error|Empty|Blurb)$/;
// Props and keys that never hold copy.
const TECH_NAME = /^(?:className|class|style|href|src|srcSet|id|key|type|kind|name|variant|size|role|as|to|rel|target|method|lang|dir|align|side|inputMode|autoComplete|autoCapitalize|autoCorrect|keyboardType|returnKeyType|textContentType|testID|nativeID|pointerEvents|resizeMode|contentFit|mode|color|tintColor|icon|systemName|value|defaultValue|ref|form|htmlFor|accept|pattern|min|max|step|sizes|xmlns|viewBox|d|fill|stroke|transform|path|url|slug|route|pathname|format|ext|mime|font|fontFamily|fontWeight|transition|animation|boxShadow|background|cursor|display|position|tag|kbd|shortcut|keys|accelerator|command|cmd|event|channel|provider|model|modelId|providerId|state|status|phase|field|sort|order|filter|scope)$|^(?:data-|on[A-Z])/;
// Calls whose string arguments are copy.
const TEXT_CALL = /^(?:toast|alert|confirm|prompt|notify|announce|showToast|fail|say)$|^set(?:Error|Status|Message|Notice|Toast|Hint|Label|Title|Warning|Problem|Failure|Note|Info|Caption|Empty|Busy|Progress)$/;
// Calls whose string arguments never are.
const SKIP_CALL = /^(?:cn|clsx|cva|twMerge|classNames|cx|invoke|require|import|querySelector|querySelectorAll|getElementById|closest|matches|addEventListener|removeEventListener|getAttribute|setAttribute|removeAttribute|hasAttribute|getItem|setItem|removeItem|emit|listen|once|on|off|startsWith|endsWith|includes|indexOf|lastIndexOf|replace|replaceAll|split|join|match|matchAll|test|search|describe|it|before|after|beforeEach|afterEach|expect|fetch|URL|URLSearchParams|RegExp|Symbol|getPropertyValue|setProperty|removeProperty|createElement|localeCompare|padStart|padEnd|execAsync|runAsync|getAllAsync|getFirstAsync|prepareAsync|runSync|getAllSync|getFirstSync|execSync|exec|run|all|get|set|has|delete|push|navigate|openURL|openUrl|open|encodeURIComponent|decodeURIComponent|createContext|useState|Number|String|parseInt|parseFloat|toLocaleDateString|toLocaleString|toLocaleTimeString|DateTimeFormat|NumberFormat|RelativeTimeFormat|PluralRules|Intl|define|keyword|tag|styleTags|syntaxTree|EditorView|baseTheme|theme|matchMedia|postMessage|dispatchEvent|CustomEvent|Event|Blob|File|atob|btoa|TextEncoder|readTextFile|writeTextFile|stat|exists|mkdir|remove|cmd)$/;
const TEST_CALL = /^(?:assert|assert\..*|t\..*|console\..*|log|debug|warn|info|trace)$/;

function calleeName(expr) {
  const t = typescript();
  if (t.isIdentifier(expr)) return expr.text;
  if (t.isPropertyAccessExpression(expr)) return expr.name.text;
  if (t.isElementAccessExpression(expr)) return calleeName(expr.expression);
  return '';
}
function calleeFull(expr) {
  const t = typescript();
  if (t.isIdentifier(expr)) return expr.text;
  if (t.isPropertyAccessExpression(expr)) return `${calleeFull(expr.expression)}.${expr.name.text}`;
  return '';
}
function propName(name) {
  const t = typescript();
  if (!name) return '';
  if (t.isIdentifier(name) || t.isStringLiteral(name) || t.isPrivateIdentifier(name)) return name.text;
  return '';
}

/**
 * Decide whether a literal is copy.
 * 'text': shown to the person. 'skip': never copy. 'maybe': copy if it reads like prose.
 */
function context(node) {
  const t = typescript();
  let child = node;
  let parent = node.parent;
  for (;;) {
    if (!parent) return { kind: 'maybe' };
    if (t.isImportDeclaration(parent) || t.isExportDeclaration(parent) || t.isExternalModuleReference(parent) || t.isLiteralTypeNode(parent) || t.isImportTypeNode(parent)) return { kind: 'skip' };
    if (t.isElementAccessExpression(parent) && parent.argumentExpression === child) return { kind: 'skip' };
    if (t.isBinaryExpression(parent)) {
      const op = parent.operatorToken.kind;
      if ([t.SyntaxKind.EqualsEqualsEqualsToken, t.SyntaxKind.ExclamationEqualsEqualsToken, t.SyntaxKind.EqualsEqualsToken, t.SyntaxKind.ExclamationEqualsToken, t.SyntaxKind.InKeyword, t.SyntaxKind.InstanceOfKeyword].includes(op)) return { kind: 'skip' };
      if (op === t.SyntaxKind.EqualsToken && t.isPropertyAccessExpression(parent.left)) {
        const key = parent.left.name.text;
        if (/^(?:textContent|innerText|title|placeholder|ariaLabel|alt|label)$/.test(key)) return { kind: 'text', name: key };
        if (/^(?:className|innerHTML|href|src|id|cssText|textTransform|letterSpacing)$/.test(key)) return { kind: 'skip' };
        return { kind: 'maybe' };
      }
      child = parent; parent = parent.parent; continue;
    }
    if (t.isCaseClause(parent) && parent.expression === child) return { kind: 'skip' };
    if (t.isPropertyAssignment(parent)) {
      if (parent.name === child) return { kind: 'skip' };
      const key = propName(parent.name);
      if (TECH_NAME.test(key)) return { kind: 'skip' };
      if (TEXT_NAME.test(key)) return { kind: 'text', name: key };
      return { kind: 'maybe', name: key };
    }
    if (t.isPropertyDeclaration(parent) || t.isMethodDeclaration(parent) || t.isPropertySignature(parent) || t.isEnumMember(parent)) {
      if (parent.name === child) return { kind: 'skip' };
      return { kind: 'maybe' };
    }
    if (t.isComputedPropertyName(parent)) return { kind: 'skip' };
    if (t.isJsxAttribute(parent)) {
      const key = propName(parent.name) || parent.name.getText();
      if (TECH_NAME.test(key)) return { kind: 'skip' };
      if (TEXT_NAME.test(key)) return { kind: 'text', name: key };
      return { kind: 'maybe', name: key };
    }
    if (t.isJsxExpression(parent)) {
      if (parent.parent && (t.isJsxElement(parent.parent) || t.isJsxFragment(parent.parent))) return { kind: 'text', name: 'children' };
      child = parent; parent = parent.parent; continue;
    }
    if (t.isCallExpression(parent) || t.isNewExpression(parent)) {
      if (parent.expression === child) return { kind: 'skip' };
      const name = calleeName(parent.expression);
      const full = calleeFull(parent.expression);
      if (TEST_CALL.test(full) || TEST_CALL.test(name)) return { kind: 'skip' };
      if (full.startsWith('toast') || full.startsWith('Alert.') || TEXT_CALL.test(name)) return { kind: 'text', name: full || name };
      if (SKIP_CALL.test(name) || full.startsWith('console.') || full.startsWith('router.') || full.startsWith('Linking.') || full.startsWith('JSON.') || full.startsWith('Object.') || full.startsWith('Math.')) return { kind: 'skip' };
      return { kind: 'maybe', name: full || name };
    }
    if (t.isVariableDeclaration(parent)) {
      const key = propName(parent.name);
      if (TEXT_NAME.test(key) || /(?:label|title|message|copy|placeholder|hint|empty|heading|caption|blurb|tooltip)s?$/i.test(key)) return { kind: 'text', name: key };
      if (TECH_NAME.test(key) || /(?:class|classes|css|style|styles|sql|query|regex|re|pattern|path|url|key|id)$/i.test(key)) return { kind: 'skip' };
      return { kind: 'maybe', name: key };
    }
    if (t.isTemplateSpan(parent) || t.isTemplateExpression(parent)) {
      // A literal inside `${…}` of a template: its role is the template's role.
      if (t.isTemplateSpan(parent) && parent.literal === child) return { kind: 'maybe' };
      child = parent; parent = parent.parent; continue;
    }
    if (t.isTaggedTemplateExpression(parent)) {
      const tag = calleeName(parent.tag);
      if (/^(?:css|sql|html|gql|graphql|tw|cn|String)$/.test(tag) || tag === 'raw') return { kind: 'skip' };
      return { kind: 'maybe' };
    }
    if (t.isConditionalExpression(parent) || t.isParenthesizedExpression(parent) || t.isAsExpression(parent) || t.isSatisfiesExpression(parent) || t.isNonNullExpression(parent) || t.isArrayLiteralExpression(parent) || t.isSpreadElement(parent) || t.isTypeAssertionExpression(parent)) {
      if (t.isConditionalExpression(parent) && parent.condition === child) return { kind: 'skip' };
      child = parent; parent = parent.parent; continue;
    }
    if (t.isReturnStatement(parent) || t.isArrowFunction(parent) || t.isThrowStatement(parent)) return { kind: 'maybe' };
    return { kind: 'maybe' };
  }
}

const CLASSLIST = /^[a-z0-9:\-[\]/.#%!_()&>~*@,=]+$/;
const PLAIN_WORD = /^[(“"'‘]?[\p{L}][\p{L}'’-]*[.,!?:;…)”"'’]*$/u;

/** Does a string in an unknown position read like a sentence or a label? */
export function looksLikeProse(s) {
  const text = s.replace(/\{…\}/g, 'X').trim();
  if (text.length < 2) return false;
  if (/^(?:[a-z][\w+.-]*:\/\/|mailto:|file:|data:|\/|\.\.?\/|#|@|\$|--?[a-z])/i.test(text)) return false;
  if (/^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|PRAGMA|WITH|BEGIN|COMMIT|ROLLBACK|REPLACE)\b/.test(text)) return false;
  if (/[{};<>=`\\]|=>|\(\)|&&|\|\|/.test(text)) return false;
  if (/^[\w.-]+\.(?:md|mdx|json|ts|tsx|js|css|png|jpg|svg|html|txt|rs|toml|yaml|yml)$/i.test(text)) return false;
  const tokens = text.split(/\s+/);
  if (tokens.every((tok) => CLASSLIST.test(tok)) && tokens.some((tok) => /[-:[/]/.test(tok))) return false;
  if (tokens.length === 1) return /^[A-Z][a-z’']+(?:[ -][a-z]+)*(?:…|\.\.\.|[.!?])?$/.test(text);
  const plain = tokens.filter((tok) => PLAIN_WORD.test(tok));
  if (plain.length < 2 || plain.length / tokens.length < 0.6) return false;
  if (/^[A-Z“"‘(]/.test(text) || /[.?!…’',]/.test(text)) return true;
  return plain.filter((tok) => !/[-\d]/.test(tok)).length >= 3;
}

/** Inside a component or element that renders a keyboard shortcut hint? */
function inShortcut(node) {
  const t = typescript();
  for (let p = node.parent; p; p = p.parent) {
    if ((t.isFunctionDeclaration(p) || t.isFunctionExpression(p)) && p.name && /Shortcut$/.test(p.name.text)) return true;
    if (t.isVariableDeclaration(p) && t.isIdentifier(p.name) && /Shortcut$/.test(p.name.text)) return true;
    if (t.isJsxElement(p) && /^(?:kbd|Kbd)$/.test(p.openingElement.tagName.getText())) return true;
    if (t.isJsxSelfClosingElement(p) && /^(?:kbd|Kbd)$/.test(p.tagName.getText())) return true;
  }
  return false;
}

function literalText(node) {
  const t = typescript();
  if (t.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => `{…}${s.literal.text}`).join('');
  return node.text;
}

/**
 * Parse one file. Returns { texts, styles } where texts are
 * { line, text, raw, rawLine, context, name } and styles are eyebrow findings
 * { line, rule, detail }.
 */
export function extractTs(file, source) {
  const t = typescript();
  const kind = file.endsWith('.tsx') ? t.ScriptKind.TSX : t.ScriptKind.TS;
  const sf = t.createSourceFile(file, source, t.ScriptTarget.Latest, true, kind);
  const texts = [];
  const styles = [];
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const pushStyle = (node, text) => {
    const findings = checkStyleString(text, { allowTracking: inShortcut(node) });
    const rawStart = node.getStart(sf);
    const raw = source.slice(rawStart, node.end);
    for (const f of findings) {
      const at = raw.indexOf(text.slice(f.index, f.index + f.length));
      styles.push({ line: lineOf(at >= 0 ? rawStart + at : rawStart), rule: f.rule, detail: f.detail });
    }
  };

  const visit = (node) => {
    if (t.isJsxText(node)) {
      const text = node.text.replace(/\s+/g, ' ').trim();
      if (text && /[\p{L}—]/u.test(text)) {
        const start = node.pos + node.text.search(/\S/);
        texts.push({ line: lineOf(start), text, raw: node.text, rawLine: lineOf(node.pos), context: 'jsx', name: 'children' });
      }
    } else if (t.isStringLiteral(node) || t.isNoSubstitutionTemplateLiteral(node) || t.isTemplateExpression(node)) {
      const text = literalText(node);
      pushStyle(node, text);
      const ctx = context(node);
      if (ctx.kind === 'text' ? /[\p{L}—]/u.test(text) : ctx.kind === 'maybe' && (looksLikeProse(text) || /^\s+—\s*$|^\s*—\s+$/.test(text))) {
        const start = node.getStart(sf);
        texts.push({ line: lineOf(start), text, raw: source.slice(start, node.end), rawLine: lineOf(start), context: ctx.kind, name: ctx.name ?? '' });
      }
      if (t.isTemplateExpression(node)) node.templateSpans.forEach((s) => visit(s.expression));
      return;
    } else if (t.isPropertyAssignment(node) && /^letterSpacing$/.test(propName(node.name))) {
      const init = node.initializer;
      let value;
      if (t.isNumericLiteral(init)) value = Number(init.text);
      else if (t.isPrefixUnaryExpression(init) && init.operator === t.SyntaxKind.MinusToken) value = -1;
      else if (t.isStringLiteral(init) || t.isNoSubstitutionTemplateLiteral(init)) value = init.text;
      if (value !== undefined && positiveSpacing(value) && !inShortcut(node)) {
        styles.push({ line: lineOf(node.getStart(sf)), rule: 'eyebrow-tracking', detail: node.getText(sf) });
      }
      if (t.isStringLiteral(init) || t.isNoSubstitutionTemplateLiteral(init)) return; // value already judged
    }
    t.forEachChild(node, visit);
  };
  visit(sf);
  return { texts, styles };
}
