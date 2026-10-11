import { Type } from 'typebox';

// Pure parameter builders. Schemas are constructed at their original registration
// sites, not at module load; CHECK_KINDS remains authoritative in run-check.mjs.
// Tool registration, execution and permission/state policy remain runtime-owned.

export function acceptMutationScopeParameters() {
  return Type.Object({
    paths: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 20 }),
    disposition: Type.Union([
      Type.Literal('publishable'),
      Type.Literal('temporary'),
    ]),
    rationale: Type.String({ minLength: 8, maxLength: 500 }),
  });
}

export function structuralEditParameters() {
  return Type.Object({
    path: Type.String({ minLength: 1, maxLength: 1000 }),
    pattern: Type.String({ minLength: 1, maxLength: 20000 }),
    rewrite: Type.String({ minLength: 1, maxLength: 20000 }),
  });
}

export function safeEditParameters() {
  return Type.Object({
    path: Type.String({ minLength: 1, maxLength: 1000 }),
    operation: Type.Union([
      Type.Literal('insert_before'),
      Type.Literal('insert_after'),
      Type.Literal('replace'),
    ]),
    start_line: Type.Integer({ minimum: 1 }),
    end_line: Type.Optional(Type.Integer({ minimum: 1 })),
    text: Type.String({ minLength: 1, maxLength: 20000 }),
    expected_marker: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
  });
}

export function runCheckParameters(checkKinds) {
  return Type.Object({
    kind: Type.Union(checkKinds.map(kind => Type.Literal(kind))),
    paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 20 })),
    targets: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 20 })),
    profile: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  });
}

// Keep these two kind unions explicit: repo_search has no 'symbol' mode.
// Both builders preserve property/union ordering in the registered JSON schema.
export function indexedRepoSearchParameters() {
  return Type.Object({
    kind: Type.Optional(Type.Union([
      Type.Literal('content'),
      Type.Literal('path'),
      Type.Literal('symbol'),
    ])),
    query: Type.String({ minLength: 1, maxLength: 300 }),
    pathPrefix: Type.Optional(Type.String({ maxLength: 300 })),
    extensions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 16 }), { maxItems: 12 })),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  });
}

export function repoSearchParameters() {
  return Type.Object({
    kind: Type.Optional(Type.Union([Type.Literal('content'), Type.Literal('path')])),
    query: Type.String({ minLength: 1, maxLength: 300 }),
    pathPrefix: Type.Optional(Type.String({ maxLength: 300 })),
    extensions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 16 }), { maxItems: 12 })),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  });
}

// Pure recovery contracts only. All mutation safety and stateful execution
// remain in the runtime; these builders run at their original registration sites.
export function recoverWorktreeParameters() {
  return Type.Object({
    action: Type.Union([Type.Literal('delete_untracked'), Type.Literal('revert_tracked')]),
    path: Type.String({ minLength: 1, maxLength: 1000 }),
    expected_files: Type.Array(Type.String(), { maxItems: 200 }),
    reason: Type.String({ minLength: 1, maxLength: 500 }),
  });
}

export function undoMutationParameters() {
  return Type.Object({
    mutation_id: Type.String({ minLength: 1, maxLength: 80 }),
    expected_files: Type.Array(Type.String(), { maxItems: 200 }),
    reason: Type.String({ minLength: 1, maxLength: 500 }),
  });
}

export function rollbackLastMutationParameters() {
  return Type.Object({
    reason: Type.String({ minLength: 1, maxLength: 500 }),
  });
}
