// Import the real plugin with Node's native type stripper. This fails on
// transform-required TypeScript such as enums, namespaces or parameter properties.
await import('../src/index.ts')
