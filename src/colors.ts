import * as Parser from "web-tree-sitter";

export type Range = { start: Parser.Point; end: Parser.Point };
export type ColorFunction = (
  x: Parser.Tree,
  visibleRanges: { start: number; end: number }[]
) => Map<string, Range[]>;

export function colorGo(
  root: Parser.Tree,
  visibleRanges: { start: number; end: number }[]
) {
  const functions: Range[] = [];
  const types: Range[] = [];
  const variables: Range[] = [];
  const underlines: Range[] = [];
  // Guess package names based on paths
  var packages: { [id: string]: boolean } = {};
  function scanImport(x: Parser.SyntaxNode) {
    if (x.type == "import_spec") {
      let str = x.firstChild!.text;
      if (str.startsWith('"')) {
        str = str.substring(1, str.length - 1);
      }
      const parts = str.split("/");
      const last = parts[parts.length - 1];
      packages[last] = true;
    }
    for (const child of x.children) {
      scanImport(child);
    }
  }
  // Keep track of local vars that shadow packages
  const allScopes: Scope[] = [];
  class Scope {
    private locals = new Map<
      string,
      { modified: boolean; references: Parser.SyntaxNode[] }
    >();
    private parent: Scope | null;

    constructor(parent: Scope | null) {
      this.parent = parent;
      allScopes.push(this);
    }

    declareLocal(id: string) {
      if (this.isRoot()) return;
      if (this.locals.has(id)) {
        this.locals.get(id)!.modified = true;
      } else {
        this.locals.set(id, { modified: false, references: [] });
      }
    }

    modifyLocal(id: string) {
      if (this.isRoot()) return;
      if (this.locals.has(id)) this.locals.get(id)!.modified = true;
      else if (this.parent) this.parent.modifyLocal(id);
    }

    referenceLocal(x: Parser.SyntaxNode) {
      if (this.isRoot()) return;
      const id = x.text;
      if (this.locals.has(id)) this.locals.get(id)!.references.push(x);
      else if (this.parent) this.parent.referenceLocal(x);
    }

    isLocal(id: string): boolean {
      if (this.locals.has(id)) return true;
      if (this.parent) return this.parent.isLocal(id);
      return false;
    }

    isUnknown(id: string): boolean {
      if (packages[id]) return false;
      if (this.locals.has(id)) return false;
      if (this.parent) return this.parent.isUnknown(id);
      return true;
    }

    isModified(id: string): boolean {
      if (this.locals.has(id)) return this.locals.get(id)!.modified;
      if (this.parent) return this.parent.isModified(id);
      return false;
    }

    modifiedLocals(): Parser.SyntaxNode[] {
      const all = [];
      for (const { modified, references } of this.locals.values()) {
        if (modified) {
          all.push(...references);
        }
      }
      return all;
    }

    isPackage(id: string): boolean {
      return packages[id] && !this.isLocal(id);
    }

    isRoot(): boolean {
      return this.parent == null;
    }
  }
  const rootScope = new Scope(null);
  function scanSourceFile() {
    for (const top of root.rootNode.namedChildren) {
      scanTopLevelDeclaration(top);
    }
  }
  function scanTopLevelDeclaration(x: Parser.SyntaxNode) {
    switch (x.type) {
      case "import_declaration":
        scanImport(x);
        break;
      case "function_declaration":
      case "method_declaration":
        if (!isVisible(x, visibleRanges)) return;
        scanFunctionDeclaration(x);
        break;
      case "const_declaration":
      case "var_declaration":
        if (!isVisible(x, visibleRanges)) return;
        scanVarDeclaration(x);
        break;
      case "type_declaration":
        if (!isVisible(x, visibleRanges)) return;
        scanTypeDeclaration(x);
        break;
    }
  }
  function scanFunctionDeclaration(x: Parser.SyntaxNode) {
    const scope = new Scope(rootScope);
    for (const child of x.namedChildren) {
      switch (child.type) {
        case "identifier":
          if (isVisible(child, visibleRanges)) {
            functions.push({
              start: child.startPosition,
              end: child.endPosition,
            });
          }
          break;
        default:
          scanExpr(child, scope);
      }
    }
  }
  function scanVarDeclaration(x: Parser.SyntaxNode) {
    for (const varSpec of x.namedChildren) {
      for (const child of varSpec.namedChildren) {
        switch (child.type) {
          case "identifier":
            if (isVisible(child, visibleRanges)) {
              variables.push({
                start: child.startPosition,
                end: child.endPosition,
              });
            }
            break;
          default:
            scanExpr(child, rootScope);
        }
      }
    }
  }
  function scanTypeDeclaration(x: Parser.SyntaxNode) {
    for (const child of x.namedChildren) {
      scanExpr(child, rootScope);
    }
  }
  function scanExpr(x: Parser.SyntaxNode, scope: Scope) {
    switch (x.type) {
      case "ERROR":
        return;
      case "func_literal":
      case "method_spec":
      case "block":
      case "expression_case":
      case "type_case":
      case "for_statement":
      case "if_statement":
        scope = new Scope(scope);
        break;
      case "parameter_declaration":
      case "variadic_parameter_declaration":
      case "var_spec":
      case "const_spec":
        for (const id of x.namedChildren) {
          if (id.type == "identifier") {
            scope.declareLocal(id.text);
          }
        }
        break;
      case "short_var_declaration":
      case "range_clause":
        for (const id of x.firstChild!.namedChildren) {
          if (id.type == "identifier") {
            scope.declareLocal(id.text);
          }
        }
        break;
      case "type_switch_statement":
        scope = new Scope(scope);
        if (x.firstNamedChild!.type == "expression_list") {
          for (const id of x.firstNamedChild!.namedChildren) {
            scope.declareLocal(id.text);
          }
        }
        break;
      case "inc_statement":
      case "dec_statement":
        scope.modifyLocal(x.firstChild!.text);
        break;
      case "assignment_statement":
        for (const id of x.firstChild!.namedChildren) {
          if (id.type == "identifier") {
            scope.modifyLocal(id.text);
          }
        }
        break;
      case "call_expression":
        scanCall(x.firstChild!, scope);
        scanExpr(x.lastChild!, scope);
        return;
      case "identifier":
        scope.referenceLocal(x);
        if (isVisible(x, visibleRanges) && scope.isUnknown(x.text)) {
          variables.push({ start: x.startPosition, end: x.endPosition });
        }
        return;
      case "selector_expression":
        if (
          isVisible(x, visibleRanges) &&
          scope.isPackage(x.firstChild!.text)
        ) {
          variables.push({
            start: x.lastChild!.startPosition,
            end: x.lastChild!.endPosition,
          });
        }
        scanExpr(x.firstChild!, scope);
        scanExpr(x.lastChild!, scope);
        return;
      case "type_identifier":
        if (isVisible(x, visibleRanges)) {
          types.push({ start: x.startPosition, end: x.endPosition });
        }
        return;
    }
    for (const child of x.namedChildren) {
      scanExpr(child, scope);
    }
  }
  function scanCall(x: Parser.SyntaxNode, scope: Scope) {
    switch (x.type) {
      case "identifier":
        if (isVisible(x, visibleRanges) && scope.isUnknown(x.text)) {
          functions.push({ start: x.startPosition, end: x.endPosition });
        }
        scope.referenceLocal(x);
        return;
      case "selector_expression":
        if (
          isVisible(x, visibleRanges) &&
          scope.isPackage(x.firstChild!.text)
        ) {
          functions.push({
            start: x.lastChild!.startPosition,
            end: x.lastChild!.endPosition,
          });
        }
        scanExpr(x.firstChild!, scope);
        scanExpr(x.lastChild!, scope);
        return;
      case "unary_expression":
        scanCall(x.firstChild!, scope);
        return;
      default:
        scanExpr(x, scope);
    }
  }
  scanSourceFile();
  for (const scope of allScopes) {
    for (const local of scope.modifiedLocals()) {
      underlines.push({ start: local.startPosition, end: local.endPosition });
    }
  }

  return new Map([
    ["entity.name.function", functions],
    ["entity.name.type", types],
    ["variable", variables],
    ["markup.underline", underlines],
  ]);
}

type Colors = Map<string, Range[]>;

const setScopeAndRangeToColorsMap = (colors: Colors) => (scope: string, cursor: Parser.TreeCursor | Parser.SyntaxNode) => {
  if (!colors.has(scope)) {
    colors.set(scope, []);
  }

  const ranges = colors.get(scope);

  ranges?.push({ start: cursor.startPosition, end: cursor.endPosition });
};

export function colorTypescript(
  root: Parser.Tree,
  visibleRanges: { start: number; end: number }[]
) {
  const colors: Colors = new Map();

  let visitedChildren = false;
  let cursor = root.walk();
  let parents = [cursor.nodeType];

  while (true) {
    // Advance cursor
    if (visitedChildren) {
      if (cursor.gotoNextSibling()) {
        visitedChildren = false;
      } else if (cursor.gotoParent()) {
        parents.pop();
        visitedChildren = true;
        continue;
      } else {
        break;
      }
    } else {
      const parent = cursor.nodeType;

      if (cursor.gotoFirstChild()) {
        parents.push(parent);
        visitedChildren = false;
      } else {
        visitedChildren = true;

        continue;
      }
    }
    // Skip nodes that are not visible
    if (!visible(cursor, visibleRanges)) {
      visitedChildren = true;

      continue;
    }

    // Color tokens
    const parent = parents[parents.length - 1];
    const setScope = setScopeAndRangeToColorsMap(colors);

    switch (cursor.nodeType) {
      case 'instanceof':
        setScope('keyword.operator.instanceof', cursor);

        break;

      case 'as_expression':
        setScope('keyword.operator.as', cursor);

        break;

      case 'new_expression':
        setScope('keyword.operator.new', cursor);

        break;

      case "identifier":
        if (parent == "function") {
          setScope('entity.name.function', cursor);

          break;
        }

        if (/^[A-Z0-9_]$/.test(cursor.nodeText)) {
          setScope('constant.language', cursor);
        }

        break;

      case "type_identifier":
      case "predefined_type":
        setScope('entity.name.type', cursor);

        break;

      case "property_identifier":
        if (parent === 'enum_body') {
          setScope('variable.other.enummember', cursor);
          
          break;
        }

        setScope('variable', cursor);

        break;

      case "method_definition":
        const firstChild = cursor.currentNode().firstChild!;

        if (/^(?:get|set)$/.test(firstChild.text)) {
          setScope('keyword', cursor);
        }

        break;

      case "function_declaration": {
        setScope('entity.name.function', cursor.currentNode().firstNamedChild!);

        break;
      }

      case "readonly":
        setScope('keyword', cursor);

        break;

      case "number":
        setScope('constant.numeric', cursor);

        break;

      case "?":
        if (parent === "property_signature") {
          setScope('keyword.operator.optional.ts', cursor);
        }

        break;

      case '${':
        if (parent === 'template_substitution') {
          setScope('punctuation.definition.template-expression.begin', cursor);
        }

        break;

      case '}':
        if (parent === 'template_substitution') {
          setScope('punctuation.definition.template-expression.end', cursor);
        }

        break;

      default:
    }
  }

  cursor.delete();

  return colors;
}

export function colorRuby(
  root: Parser.Tree,
  visibleRanges: { start: number; end: number }[]
) {
  const controlKeywords = new Set([
    "while",
    "until",
    "if",
    "unless",
    "for",
    "begin",
    "elsif",
    "else",
    "ensure",
    "when",
    "case",
    "do_block",
  ]);
  const classKeywords = new Set([
    "include",
    "prepend",
    "extend",
    "private",
    "protected",
    "public",
    "attr_reader",
    "attr_writer",
    "attr_accessor",
    "attr",
    "private_class_method",
    "public_class_method",
  ]);
  const moduleKeywords = new Set(["module_function", ...classKeywords]);
  const functions: Range[] = [];
  const types: Range[] = [];
  const variables: Range[] = [];
  const keywords: Range[] = [];
  const controls: Range[] = [];
  const constants: Range[] = [];
  let visitedChildren = false;
  let cursor = root.walk();
  let parents = [cursor.nodeType];
  function isChildOf(ancestor: string) {
    const parent = parents[parents.length - 1];
    const grandparent = parents[parents.length - 2];
    // class Foo; bar; end
    if (parent == ancestor) {
      return true;
    }
    // class Foo; bar :thing; end
    if (parent == "method_call" && grandparent == ancestor) {
      return true;
    }
    return false;
  }
  while (true) {
    // Advance cursor
    if (visitedChildren) {
      if (cursor.gotoNextSibling()) {
        visitedChildren = false;
      } else if (cursor.gotoParent()) {
        parents.pop();
        visitedChildren = true;
        continue;
      } else {
        break;
      }
    } else {
      const parent = cursor.nodeType;
      if (cursor.gotoFirstChild()) {
        parents.push(parent);
        visitedChildren = false;
      } else {
        visitedChildren = true;
        continue;
      }
    }
    // Skip nodes that are not visible
    if (!visible(cursor, visibleRanges)) {
      visitedChildren = true;
      continue;
    }
    // Color tokens
    const parent = parents[parents.length - 1];
    switch (cursor.nodeType) {
      case "method":
        cursor.gotoFirstChild();
        cursor.gotoNextSibling();
        functions.push({
          start: cursor.startPosition,
          end: cursor.endPosition,
        });
        cursor.gotoParent();
        break;
      case "singleton_method":
        cursor.gotoFirstChild();
        cursor.gotoNextSibling();
        cursor.gotoNextSibling();
        cursor.gotoNextSibling();
        functions.push({
          start: cursor.startPosition,
          end: cursor.endPosition,
        });
        cursor.gotoParent();
        break;
      case "instance_variable":
      case "class_variable":
      case "global_variable":
        variables.push({
          start: cursor.startPosition,
          end: cursor.endPosition,
        });
        break;
      case "end":
        if (controlKeywords.has(parent)) {
          controls.push({
            start: cursor.startPosition,
            end: cursor.endPosition,
          });
        } else {
          keywords.push({
            start: cursor.startPosition,
            end: cursor.endPosition,
          });
        }
        break;
      case "constant":
        types.push({ start: cursor.startPosition, end: cursor.endPosition });
        break;
      case "symbol":
        constants.push({
          start: cursor.startPosition,
          end: cursor.endPosition,
        });
        break;
      case "method_call": {
        cursor.gotoFirstChild();
        const text = cursor.currentNode().text;
        if (!moduleKeywords.has(text)) {
          functions.push({
            start: cursor.startPosition,
            end: cursor.endPosition,
          });
        }
        cursor.gotoParent();
        break;
      }
      case "call":
        cursor.gotoFirstChild();
        cursor.gotoNextSibling();
        cursor.gotoNextSibling();
        functions.push({
          start: cursor.startPosition,
          end: cursor.endPosition,
        });
        cursor.gotoParent();
        break;
      case "identifier": {
        const text = cursor.currentNode().text;
        if (classKeywords.has(text) && isChildOf("class")) {
          keywords.push({
            start: cursor.startPosition,
            end: cursor.endPosition,
          });
        } else if (moduleKeywords.has(text) && isChildOf("module")) {
          keywords.push({
            start: cursor.startPosition,
            end: cursor.endPosition,
          });
        }
        break;
      }
    }
  }
  cursor.delete();
  return new Map([
    ["entity.name.function", functions],
    ["entity.name.type", types],
    ["variable", variables],
    ["keyword", keywords],
    ["keyword.control", controls],
    ["constant.language", constants],
  ]);
}

export function colorRust(
  root: Parser.Tree,
  visibleRanges: { start: number; end: number }[]
) {
  const functions: Range[] = [];
  const types: Range[] = [];
  const variables: Range[] = [];
  const keywords: Range[] = [];
  let visitedChildren = false;
  let cursor = root.walk();
  let parents = [cursor.nodeType];
  while (true) {
    // Advance cursor
    if (visitedChildren) {
      if (cursor.gotoNextSibling()) {
        visitedChildren = false;
      } else if (cursor.gotoParent()) {
        parents.pop();
        visitedChildren = true;
        continue;
      } else {
        break;
      }
    } else {
      const parent = cursor.nodeType;
      if (cursor.gotoFirstChild()) {
        parents.push(parent);
        visitedChildren = false;
      } else {
        visitedChildren = true;
        continue;
      }
    }
    // Skip nodes that are not visible
    if (!visible(cursor, visibleRanges)) {
      visitedChildren = true;
      continue;
    }
    // Color tokens
    const parent = parents[parents.length - 1];
    const grandparent = parents[parents.length - 2];
    switch (cursor.nodeType) {
      case "identifier":
        if (parent == "function_item" && grandparent == "declaration_list") {
          variables.push({
            start: cursor.startPosition,
            end: cursor.endPosition,
          });
        } else if (parent == "function_item") {
          functions.push({
            start: cursor.startPosition,
            end: cursor.endPosition,
          });
        } else if (
          parent == "scoped_identifier" &&
          grandparent == "function_declarator"
        ) {
          functions.push({
            start: cursor.startPosition,
            end: cursor.endPosition,
          });
        }
        break;
      case "type_identifier":
      case "primitive_type":
        types.push({ start: cursor.startPosition, end: cursor.endPosition });
        break;
      case "field_identifier":
        variables.push({
          start: cursor.startPosition,
          end: cursor.endPosition,
        });
        break;
      case "use_list":
    }
  }
  cursor.delete();
  return new Map([
    ["entity.name.function", functions],
    ["entity.name.type", types],
    ["variable", variables],
    ["keyword", keywords],
  ]);
}

export function colorCpp(
  root: Parser.Tree,
  visibleRanges: { start: number; end: number }[]
) {
  const functions: Range[] = [];
  const types: Range[] = [];
  const variables: Range[] = [];
  let visitedChildren = false;
  let cursor = root.walk();
  let parents = [cursor.nodeType];
  while (true) {
    // Advance cursor
    if (visitedChildren) {
      if (cursor.gotoNextSibling()) {
        visitedChildren = false;
      } else if (cursor.gotoParent()) {
        parents.pop();
        visitedChildren = true;
        continue;
      } else {
        break;
      }
    } else {
      const parent = cursor.nodeType;
      if (cursor.gotoFirstChild()) {
        parents.push(parent);
        visitedChildren = false;
      } else {
        visitedChildren = true;
        continue;
      }
    }
    // Skip nodes that are not visible
    if (!visible(cursor, visibleRanges)) {
      visitedChildren = true;
      continue;
    }
    // Color tokens
    const parent = parents[parents.length - 1];
    const grandparent = parents[parents.length - 2];
    switch (cursor.nodeType) {
      case "identifier":
        if (
          parent == "function_declarator" ||
          (parent == "scoped_identifier" &&
            grandparent == "function_declarator")
        ) {
          functions.push({
            start: cursor.startPosition,
            end: cursor.endPosition,
          });
        }
        break;
      case "type_identifier":
        types.push({ start: cursor.startPosition, end: cursor.endPosition });
        break;
      case "field_identifier":
        variables.push({
          start: cursor.startPosition,
          end: cursor.endPosition,
        });
        break;
    }
  }
  cursor.delete();
  return new Map([
    ["entity.name.function", functions],
    ["entity.name.type", types],
    ["variable", variables],
  ]);
}

function isVisible(
  x: Parser.SyntaxNode,
  visibleRanges: { start: number; end: number }[]
) {
  for (const { start, end } of visibleRanges) {
    const overlap =
      x.startPosition.row <= end + 1 && start - 1 <= x.endPosition.row;
    if (overlap) return true;
  }
  return false;
}
function visible(
  x: Parser.TreeCursor,
  visibleRanges: { start: number; end: number }[]
) {
  for (const { start, end } of visibleRanges) {
    const overlap =
      x.startPosition.row <= end + 1 && start - 1 <= x.endPosition.row;
    if (overlap) return true;
  }
  return false;
}
