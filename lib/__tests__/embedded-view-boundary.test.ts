import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const allowedExternal = new Set(['react', 'zustand', 'zustand/vanilla', 'next-intl']);
const allowedInternal = new Set(['stores/auth-store', 'components/plugins/embedded-view']);
const network = new Set(['fetch', 'apiFetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'getAuthHeader']);

/** A dependency sensor for the platform-only kernel, not a provider-name denylist. */
function violations(file: string, content: string): string[] {
  const errors: string[] = [];
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (!allowedExternal.has(specifier)) {
        const target = specifier.startsWith('@/') ? specifier.slice(2) : path.relative(root, path.resolve(path.dirname(file), specifier));
        if (!target.startsWith('lib/plugin-embedded/') && !allowedInternal.has(target)) errors.push(`dependency: ${specifier}`);
      }
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const expression = node.expression;
      const name = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : '';
      if (network.has(name) || expression.kind === ts.SyntaxKind.ImportKeyword) errors.push(`I/O: ${name}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return errors;
}

it('keeps the embedded runtime dependent only on browser UI, lifecycle and authority primitives', () => {
  const files = readdirSync(path.join(root, 'lib/plugin-embedded')).filter(file => file.endsWith('.ts')).map(file => `lib/plugin-embedded/${file}`);
  files.push('components/plugins/embedded-view.tsx', 'components/plugins/embedded-workspace.tsx');
  for (const file of files) expect(violations(path.join(root, file), readFileSync(path.join(root, file), 'utf8')), file).toEqual([]);
});

it('the dependency sensor rejects backend imports and network calls', () => {
  const file = path.join(root, 'lib/plugin-embedded/example.ts');
  expect(violations(file, "import { request } from '../application-service'; fetch('/example');")).toEqual(['dependency: ../application-service', 'I/O: fetch']);
});
