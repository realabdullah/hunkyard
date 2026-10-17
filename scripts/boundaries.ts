import ts from 'typescript';

export const importedModules = (text: string, filename: string): string[] => {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push(node.moduleSpecifier.text);
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      imports.push(node.argument.literal.text);
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const argument = node.arguments[0];
      if (!argument || !ts.isStringLiteral(argument))
        throw new Error(`${filename}: nonliteral module import is forbidden`);
      imports.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
};

export const allowedDependencies: Record<string, readonly string[]> = {
  '@reviewlab/domain': ['zod'],
  '@reviewlab/core': ['@reviewlab/domain'],
  '@reviewlab/providers': ['@reviewlab/domain', 'zod'],
  '@reviewlab/git': ['@reviewlab/domain'],
  '@reviewlab/context': ['@reviewlab/domain'],
  '@reviewlab/storage': ['@reviewlab/domain'],
  '@reviewlab/agents': ['@reviewlab/domain'],
  '@reviewlab/testing': [
    'reviewlab-vscode',
    '@reviewlab/providers',
    '@reviewlab/context',
    '@reviewlab/agents',
    '@reviewlab/server',
    '@reviewlab/domain',
    '@reviewlab/core',
    '@reviewlab/git',
    '@reviewlab/storage',
  ],
};

export const assertAcyclic = (graph: Map<string, string[]>) => {
  const done = new Set<string>();
  const visit = (name: string, path: string[]) => {
    if (path.includes(name)) throw new Error(`Dependency cycle: ${[...path, name].join(' -> ')}`);
    if (done.has(name)) return;
    for (const dependency of graph.get(name) ?? [])
      if (graph.has(dependency)) visit(dependency, [...path, name]);
    done.add(name);
  };
  for (const name of graph.keys()) visit(name, []);
};
