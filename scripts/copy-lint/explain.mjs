// The over-explaining rule (docs/voice.md › Let the components do the
// talking). Deterministic: string lengths by role, a few set phrases, and
// the shape of the JSX around a string. No model.

/** Most words a button, label or title may have. */
export const LABEL_WORDS = 5;
/** Most words helper text, a description or a subtitle may have. */
export const HELPER_WORDS = 12;
/** Most words an empty state may have, and most sentences. */
export const EMPTY_WORDS = 12;
export const EMPTY_SENTENCES = 2;

/** Props and keys that hold a secondary line under something else. */
export const HELPER_PROP = /^(?:description|subtitle|subTitle|helper|helperText|hint|help|lede|blurb|intro|explainer)$|[a-z](?:Description|Subtitle|Hint|Helper|HelperText|Blurb)$/;
/** The same, as a JSX prop that puts a second line on a control or row. */
const HELPER_ATTR = /^(?:description|subtitle|subTitle|helper|helperText|hint|lede|blurb)$/;

/** Sentences that narrate the interface. */
export const NARRATION = /(?:^|[.!?…]\s+|\n\s*)((?:this|that|it) (?:lets|allows|helps|enables) you\b|(?:use|tap|click|press|select) (?:this|here) to\b|here you can\b|here['’]s where you\b|this is where you\b|(?:tap|click|press) (?:to|here)\b)/gi;

const TRANSPARENT = /^(?:Text|span|strong|em|b|i|small|Trans|>)$/;
const CONTROL = /^(?:button|Button|[\w.]*Button|Pressable|TouchableOpacity|TouchableHighlight|[\w.]*MenuAction|[\w.]*MenuItem|DropdownMenuItem|ContextMenuItem|TabsTrigger|ToggleGroupItem|SelectItem)$/;
const INPUT = /^(?:input|select|textarea|TextInput|Input|Textarea|Select|SelectTrigger|Switch|Checkbox|Slider|Toggle|RadioGroup)$/;
const HELPER_TAG = /^(?:[\w.]*Description|[\w.]*Subtitle|[\w.]*HelperText|FormDescription)$/;
const HEADING_TAG = /^(?:h[1-6]|Stack\.Title|Stack\.Screen|[\w.]*Title|[\w.]*Heading)$/;
const HELPER_STYLE = /\bstyles\.(?:lede|subtitle|subTitle|description|helper|helperText|hint|blurb|intro|explainer)\b/;
const EMPTY_STYLE = /\bstyles\.(?:empty|emptyText|emptyLine)\b/;
const HEADING_STYLE = /\bstyles\.(?:title|heading|header|headerText|sectionTitle|pageTitle)\b/;

function tagOf(el, sf) {
  const open = el.openingElement ?? el;
  return open.tagName ? open.tagName.getText(sf) : '>';
}
function attrsText(el, sf) {
  const open = el.openingElement ?? el;
  return open.attributes ? open.attributes.getText(sf) : '';
}
function isElement(t, node) {
  return t.isJsxElement(node) || t.isJsxSelfClosingElement(node) || t.isJsxFragment(node);
}
const isHelper = (el, sf) => HELPER_TAG.test(tagOf(el, sf)) || HELPER_STYLE.test(attrsText(el, sf));
const isHeading = (el, sf) => HEADING_TAG.test(tagOf(el, sf)) || HEADING_STYLE.test(attrsText(el, sf));
const isControl = (el, sf) => CONTROL.test(tagOf(el, sf)) || INPUT.test(tagOf(el, sf));

/** Has literal text of its own and isn't screen-reader only. */
function showsText(t, el, sf) {
  for (let p = el; p; p = p.parent) if (isElement(t, p) && !t.isJsxFragment(p) && /\bsr-only\b/.test(attrsText(p, sf))) return false;
  return t.isJsxElement(el) && el.children.some((c) => (t.isJsxText(c) && /\p{L}/u.test(c.text)) || (t.isJsxExpression(c) && c.expression && hasLiteral(t, c.expression)));
}

/** The role of a string rendered as JSX children: 'label', 'helper', 'empty' or ''. */
export function jsxRole(t, node, sf) {
  let el = node.parent;
  while (el && !isElement(t, el)) {
    if (t.isJsxAttribute(el) || t.isFunctionLike(el)) return '';
    el = el.parent;
  }
  if (!el) return '';
  if (isHelper(el, sf)) return 'helper';
  if (EMPTY_STYLE.test(attrsText(el, sf))) return 'empty';
  // Text inside a button (through a <Text> or <span> or two) is its label.
  for (let p = el, depth = 0; p && depth < 3; depth++) {
    if (CONTROL.test(tagOf(p, sf))) return 'label';
    if (!TRANSPARENT.test(tagOf(p, sf))) break;
    p = p.parent;
    while (p && !isElement(t, p) && !t.isFunctionLike(p)) p = p.parent;
    if (p && !isElement(t, p)) break;
  }
  return '';
}

/**
 * Elements that only explain their neighbour: a helper-styled element (a
 * lede, subtitle, description or hint) straight after a heading or a
 * control, and helper props (`subtitle=`, `description=`, `hint=`) with
 * literal text. Returns [{ pos, detail }].
 */
export function explainerElements(t, sf) {
  const out = [];
  const visit = (node) => {
    if (t.isJsxElement(node) || t.isJsxFragment(node)) {
      let prev = null;
      for (const child of node.children) {
        if (t.isJsxText(child) && !child.text.trim()) continue;
        if (isElement(t, child) && prev && isHelper(child, sf) && (isHeading(prev, sf) || isControl(prev, sf)) && showsText(t, child, sf)) {
          out.push({ pos: child.getStart(sf), detail: `<${tagOf(child, sf)}> under <${tagOf(prev, sf)}>: delete it, or keep one fact the UI can't show` });
        }
        prev = isElement(t, child) ? child : null;
      }
    }
    if ((t.isJsxElement(node)) && EMPTY_STYLE.test(attrsText(node, sf))) {
      const lines = textLeaves(t, node, sf);
      if (lines > 1) out.push({ pos: node.getStart(sf), detail: `empty state of ${lines} lines (one line, at most one action)` });
    }
    if (t.isJsxAttribute(node) && HELPER_ATTR.test(node.name.getText(sf)) && node.initializer) {
      let init = node.initializer;
      if (t.isJsxExpression(init)) init = init.expression;
      if (init && (t.isStringLiteral(init) || t.isNoSubstitutionTemplateLiteral(init) || t.isTemplateExpression(init)) && /\p{L}/u.test(init.getText(sf))) {
        out.push({ pos: node.getStart(sf), detail: `${node.name.getText(sf)}= on <${tagOf(node.parent.parent, sf)}>: the control says it already` });
      }
    }
    t.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Elements under `root` that show text of their own, not counting controls. */
function textLeaves(t, root, sf) {
  let n = 0;
  const visit = (node) => {
    if (node !== root && isElement(t, node) && isControl(node, sf)) return;
    if (t.isJsxElement(node) && node.children.some((c) => (t.isJsxText(c) && /\p{L}/u.test(c.text)) || (t.isJsxExpression(c) && c.expression && hasLiteral(t, c.expression)))) n++;
    t.forEachChild(node, visit);
  };
  visit(root);
  return n;
}
function hasLiteral(t, node) {
  if (t.isStringLiteral(node) || t.isNoSubstitutionTemplateLiteral(node) || t.isTemplateExpression(node)) return /\p{L}/u.test(node.getText());
  if (t.isJsxElement(node) || t.isJsxSelfClosingElement(node) || t.isFunctionLike(node)) return false;
  let found = false;
  t.forEachChild(node, (c) => { if (!found && hasLiteral(t, c)) found = true; });
  return found;
}

export function wordCount(text) {
  return text.replace(/\{…\}/g, 'X').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
export function sentenceCount(text) {
  const body = text.replace(/\{…\}/g, 'X').trim();
  if (!body) return 0;
  return body.split(/(?<=[.!?…])\s+(?=[\p{Lu}\p{N}“"‘(X])/u).filter((s) => /[\p{L}\p{N}]/u.test(s)).length;
}

/**
 * Text checks for one extracted string with its role. Returns
 * [{ rule, index, length, detail }] like checkText.
 */
export function checkExplaining(text, role) {
  const out = [];
  for (const m of text.matchAll(NARRATION)) {
    out.push({ rule: 'over-explaining', index: m.index + m[0].indexOf(m[1]), length: m[1].length, detail: `"${m[1]}…" narrates the UI` });
  }
  const words = wordCount(text);
  const whole = (detail) => out.push({ rule: 'over-explaining', index: 0, length: text.length, detail });
  if (role === 'label' && words > LABEL_WORDS) whole(`label of ${words} words (max ${LABEL_WORDS})`);
  if (role === 'helper' && words > HELPER_WORDS) whole(`helper text of ${words} words (max ${HELPER_WORDS})`);
  if (role === 'empty') {
    const sentences = sentenceCount(text);
    if (words > EMPTY_WORDS) whole(`empty state of ${words} words (max ${EMPTY_WORDS})`);
    else if (sentences > EMPTY_SENTENCES) whole(`empty state of ${sentences} sentences (one line, at most one action)`);
  }
  return out;
}
