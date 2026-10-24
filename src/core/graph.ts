import ts from "typescript";
import { posix, matchesGlob } from "node:path";
import type {
  Team,
  PlanGraph,
  ContractPlan,
  Change,
  ImpactFinding,
} from "../shared/types";
export const emptyGraph = (): PlanGraph => ({
  version: 1,
  modules: [],
  contracts: [],
  dependencies: [],
});
export const moduleOwners = (
  module: PlanGraph["modules"][number],
): string[] => [
  ...new Set(module.ownerIds ?? (module.ownerId ? [module.ownerId] : [])),
];
export function matchesPath(path: string, glob: string): boolean {
  return matchesGlob(path.replaceAll("\\", "/"), glob.replaceAll("\\", "/"));
}
export function extractContracts(
  path: string,
  source: string,
  moduleId: string,
): ContractPlan[] {
  const contracts: ContractPlan[] = [];
  const add = (name: string, kind: ContractPlan["kind"], signature: string) => {
    const id = `${moduleId}:${path}:${name}`;
    const previous = contracts.find((c) => c.id === id);
    if (previous) {
      if (previous.signature !== signature.trim()) {
        const unpack = (raw: string): unknown[] => {
          try {
            const value = JSON.parse(raw);
            return value.overloads ?? [value];
          } catch {
            return [raw];
          }
        };
        const variants = [
          ...new Map(
            [...unpack(previous.signature), ...unpack(signature)].map((v) => [
              JSON.stringify(v),
              v,
            ]),
          ).values(),
        ];
        previous.signature = JSON.stringify({
          overloads: variants.sort((a, b) =>
            JSON.stringify(a).localeCompare(JSON.stringify(b)),
          ),
        });
      }
      return;
    }
    contracts.push({
      id,
      moduleId,
      path,
      name,
      kind,
      signature: signature.trim(),
      version: 1,
    });
  };
  if (/\.[cm]?[jt]sx?$/.test(path)) {
    const file = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      /tsx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const exported = (node: ts.Node) =>
      ts.canHaveModifiers(node) &&
      ts
        .getModifiers(node)
        ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const printer = ts.createPrinter({ removeComments: true });
    const print = (node: ts.Node) =>
      printer
        .printNode(ts.EmitHint.Unspecified, node, file)
        .replace(/\s+/g, " ")
        .trim();
    const name = (node: ts.PropertyName | undefined) =>
      !node
        ? ""
        : ts.isStringLiteral(node) || ts.isNumericLiteral(node)
          ? node.text
          : print(node);
    function typeShape(node: ts.TypeNode | undefined): unknown {
      if (!node) return "inferred";
      if (ts.isTypeLiteralNode(node))
        return {
          object: node.members
            .map(memberShape)
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        };
      if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node))
        return {
          kind: ts.isUnionTypeNode(node) ? "union" : "intersection",
          types: node.types
            .map(typeShape)
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        };
      if (ts.isArrayTypeNode(node))
        return { array: typeShape(node.elementType) };
      if (
        ts.isTypeReferenceNode(node) &&
        node.typeName.getText(file) === "Array" &&
        node.typeArguments?.length === 1
      )
        return { array: typeShape(node.typeArguments[0]) };
      if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal))
        return { literal: node.literal.text };
      return print(node);
    }
    function parameters(nodes: ts.NodeArray<ts.ParameterDeclaration>) {
      return nodes.map((parameter) => ({
        rest: !!parameter.dotDotDotToken,
        optional: !!(parameter.questionToken || parameter.initializer),
        type: typeShape(parameter.type),
      }));
    }
    function memberShape(member: ts.TypeElement | ts.ClassElement): unknown {
      const modifiers = ts.canHaveModifiers(member)
        ? ts.getModifiers(member)
        : undefined;
      const flags = {
        name: name(member.name),
        optional: "questionToken" in member && !!member.questionToken,
        readonly: !!modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.ReadonlyKeyword,
        ),
        static: !!modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.StaticKeyword,
        ),
      };
      if (
        ts.isMethodSignature(member) ||
        ts.isMethodDeclaration(member) ||
        ts.isConstructorDeclaration(member) ||
        ts.isCallSignatureDeclaration(member) ||
        ts.isConstructSignatureDeclaration(member)
      )
        return {
          ...flags,
          kind: ts.isConstructorDeclaration(member) ? "constructor" : "method",
          parameters: parameters(member.parameters),
          returns: typeShape(member.type),
        };
      if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member))
        return { ...flags, kind: "property", type: typeShape(member.type) };
      return print(member);
    }
    const functionShape = (
      node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression,
    ) =>
      JSON.stringify({
        parameters: parameters(node.parameters),
        returns: typeShape(node.type),
        typeParameters: node.typeParameters?.map(print) ?? [],
      });
    for (const statement of file.statements) {
      if (!exported(statement)) continue;
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        add(statement.name.text, "function", functionShape(statement));
      } else if (
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)
      )
        add(
          statement.name.text,
          ts.isInterfaceDeclaration(statement) ? "interface" : "type",
          JSON.stringify(
            ts.isInterfaceDeclaration(statement)
              ? {
                  members: statement.members
                    .map(memberShape)
                    .sort((a, b) =>
                      JSON.stringify(a).localeCompare(JSON.stringify(b)),
                    ),
                  extends: statement.heritageClauses?.map(print) ?? [],
                  typeParameters: statement.typeParameters?.map(print) ?? [],
                }
              : {
                  type: typeShape(statement.type),
                  typeParameters: statement.typeParameters?.map(print) ?? [],
                },
          ),
        );
      else if (ts.isClassDeclaration(statement) && statement.name) {
        const fields = statement.members
          .filter(
            (m) =>
              !(
                (m.name && ts.isPrivateIdentifier(m.name)) ||
                (ts.canHaveModifiers(m) &&
                  ts
                    .getModifiers(m)
                    ?.some((v) => v.kind === ts.SyntaxKind.PrivateKeyword))
              ),
          )
          .map(memberShape)
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        add(statement.name.text, "class", JSON.stringify(fields));
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations)
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.initializer &&
            (ts.isArrowFunction(declaration.initializer) ||
              ts.isFunctionExpression(declaration.initializer))
          )
            add(
              declaration.name.text,
              "function",
              functionShape(declaration.initializer),
            );
      }
    }
    function endpoints(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        ["app", "router"].includes(node.expression.expression.text) &&
        ["get", "post", "put", "patch", "delete"].includes(
          node.expression.name.text,
        ) &&
        node.arguments.length >= 2 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const route = `${node.expression.name.text.toUpperCase()} ${node.arguments[0].text}`;
        add(route, "endpoint", route);
      }
      ts.forEachChild(node, endpoints);
    }
    endpoints(file);
  }
  if (/\.sql$/i.test(path))
    for (const match of source
      .replace(/--[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .matchAll(
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?(\w+)["`\]]?\s*\(([\s\S]*?)\);/gi,
      ))
      add(match[1], "table", match[2]);
  return contracts;
}
export function deriveDependencies(
  graph: PlanGraph,
  files: Map<string, string>,
): PlanGraph["dependencies"] {
  const edges = new Map<string, { from: string; to: string }>();
  for (const [path, source] of files) {
    const from = graph.modules.find((m) => matchesPath(path, m.pathGlob));
    if (!from) continue;
    for (const match of source.matchAll(
      /(?:from\s+|require\(\s*)['"]([.][^'"]+)['"]/g,
    )) {
      const target = posix.normalize(posix.join(posix.dirname(path), match[1]));
      const to = graph.modules.find((m) =>
        [
          target,
          ...[".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.js"].map(
            (ext) => target + ext,
          ),
        ].some((p) => files.has(p) && matchesPath(p, m.pathGlob)),
      );
      if (to && to.id !== from.id)
        edges.set(`${from.id}:${to.id}`, { from: from.id, to: to.id });
    }
  }
  return [...edges.values()].map((edge) => ({
    ...edge,
    source: "observed" as const,
  }));
}
export function impact(team: Team, changes: Change[], authorId: string) {
  const graph = team.graph ?? emptyGraph();
  const moduleIds = new Set<string>();
  const findings: ImpactFinding[] = [];
  for (const change of changes) {
    const module = graph.modules.find((m) =>
      matchesPath(change.path, m.pathGlob),
    );
    if (!module) continue;
    moduleIds.add(module.id);
    if (!moduleOwners(module).includes(authorId))
      findings.push({
        type: "ownership",
        target: change.path,
        moduleId: module.id,
        explanation: `This file belongs to ${module.name}. Supporting changes can still be necessary; ownership alone is not a scope violation.`,
      });
    const after = extractContracts(change.path, change.after ?? "", module.id);
    for (const declared of graph.contracts.filter(
      (c) => c.path === change.path && c.moduleId === module.id,
    )) {
      const actual = after.find((c) => c.name === declared.name);
      if (!actual || actual.signature !== declared.signature)
        findings.push({
          type: "contract",
          target: declared.name,
          moduleId: module.id,
          explanation: `The agreed ${declared.kind} ${declared.name} ${actual ? "has a different public shape" : "was removed"}. Dependent work may need an update.`,
        });
    }
    for (const entity of after)
      if (!graph.contracts.some((c) => c.id === entity.id))
        findings.push({
          type: "new_entity",
          target: entity.name,
          moduleId: module.id,
          explanation: `New ${entity.kind} ${entity.name}; being new does not by itself make this unnecessary.`,
        });
  }
  const impacted = new Set(moduleIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of graph.dependencies)
      if (impacted.has(edge.to) && !impacted.has(edge.from)) {
        impacted.add(edge.from);
        changed = true;
      }
  }
  return {
    moduleIds: [...moduleIds],
    impactedMemberIds: [
      ...new Set(
        graph.modules
          .filter((m) => impacted.has(m.id))
          .flatMap((m) => [...moduleOwners(m), ...(m.reviewerIds ?? [])]),
      ),
    ].filter((id) => id !== authorId),
    findings,
  };
}
