import { describe, expect, it } from 'vitest';
import { compareContracts, MAX_INPUT_BYTES, parseContract } from '../src/core';
import { BASELINE_SAMPLE, CANDIDATE_SAMPLE } from '../src/sample';

const response = {
  description: 'Success',
  content: { 'application/json': { schema: { type: 'string' } } },
};
const contract = (overrides: Record<string, unknown> = {}) => ({
  openapi: '3.1.1',
  info: { title: 'Test API', version: '1.0' },
  paths: { '/items': { get: { responses: { '200': response } } } },
  ...overrides,
});
const diff = (a: unknown, b: unknown) => compareContracts(JSON.stringify(a), JSON.stringify(b));
const withSchema = (schema: unknown, direction: 'request' | 'response' = 'request') =>
  contract({
    paths: {
      '/items': {
        post: {
          ...(direction === 'request'
            ? { requestBody: { content: { 'application/json': { schema } } } }
            : {}),
          responses: {
            '200':
              direction === 'response'
                ? { description: 'Success', content: { 'application/json': { schema } } }
                : { description: 'Success' },
          },
        },
      },
    },
  });
const object = (required: string[] = []) => ({
  type: 'object',
  additionalProperties: false,
  properties: { id: { type: 'string' } },
  required,
});

describe('parsing and boundaries', () => {
  it('rejects YAML non-finite numbers rather than collapsing them to JSON null', () => {
    expect(() =>
      parseContract('openapi: 3.1.1\ninfo: {title: Test, version: "1"}\npaths: {}\nvalue: .nan'),
    ).toThrow(/non-finite/);
  });
  it('accepts JSON and YAML 3.0/3.1', () => {
    expect(parseContract(JSON.stringify(contract())).openapi).toBe('3.1.1');
    expect(
      parseContract('openapi: 3.0.3\ninfo: {title: Test, version: "1"}\npaths: {}').openapi,
    ).toBe('3.0.3');
  });
  it.each(['', '{', '[]', 'openapi: 2.0\npaths: {}', 'openapi: 3.2.0\npaths: {}'])(
    'rejects invalid or unsupported input %j',
    (text) => expect(() => parseContract(text)).toThrow(),
  );
  it('rejects duplicate JSON and YAML keys', () => {
    expect(() => parseContract('{"openapi":"3.1.1","openapi":"3.0.3"}')).toThrow(/unique/);
    expect(() => parseContract('openapi: 3.1.1\nopenapi: 3.0.3')).toThrow(/unique/);
  });
  it('rejects numeric/string YAML keys that collide after conversion', () => {
    expect(() =>
      parseContract(
        'openapi: 3.1.1\ninfo: {title: Test, version: "1"}\npaths: {}\nexample: {200: one, "200": two}',
      ),
    ).toThrow(/duplicate mapping key/);
  });
  it('rejects cyclic YAML aliases and unknown YAML tags', () => {
    expect(() =>
      parseContract(
        'openapi: 3.1.1\ninfo: {title: Test, version: "1"}\npaths: {}\nloop: &loop {self: *loop}',
      ),
    ).toThrow(/cyclic/);
    expect(() =>
      parseContract('openapi: !unknown 3.1.1\ninfo: {title: Test, version: "1"}\npaths: {}'),
    ).toThrow();
  });
  it('enforces byte and structural limits', () => {
    expect(() => parseContract(' '.repeat(MAX_INPUT_BYTES + 1))).toThrow(/512 KiB/);
    expect(() =>
      parseContract(JSON.stringify({ ...contract(), large: Array(20_001).fill(0) })),
    ).toThrow(/complexity/);
  });
});

describe('directional comparison', () => {
  it('keeps the example deterministic and fully covered', () => {
    const report = compareContracts(BASELINE_SAMPLE, CANDIDATE_SAMPLE);
    expect(report.summary).toEqual({ breaking: 6, compatible: 2, warnings: 0 });
    expect(compareContracts(BASELINE_SAMPLE, CANDIDATE_SAMPLE)).toEqual(report);
  });
  it('makes removals breaking and additions compatible', () => {
    expect(diff(contract(), contract({ paths: {} })).changes[0].severity).toBe('breaking');
    expect(diff(contract({ paths: {} }), contract()).changes[0].severity).toBe('compatible');
  });
  it.each(['request', 'response'] as const)('uses %s variance for required fields', (direction) => {
    const report = diff(withSchema(object(), direction), withSchema(object(['id']), direction));
    expect(report.changes[0].severity).toBe(direction === 'request' ? 'breaking' : 'compatible');
    const reverse = diff(withSchema(object(['id']), direction), withSchema(object(), direction));
    expect(reverse.changes[0].severity).toBe(direction === 'request' ? 'compatible' : 'breaking');
  });
  it.each(['request', 'response'] as const)('uses %s variance for enum expansion', (direction) => {
    const a = withSchema({ type: 'string', enum: ['a'] }, direction);
    const b = withSchema({ type: 'string', enum: ['a', 'b'] }, direction);
    expect(diff(a, b).changes[0].severity).toBe(
      direction === 'request' ? 'compatible' : 'breaking',
    );
    expect(diff(b, a).changes[0].severity).toBe(
      direction === 'request' ? 'breaking' : 'compatible',
    );
  });
  it('treats integer as a subset of number', () => {
    expect(
      diff(withSchema({ type: 'integer' }), withSchema({ type: 'number' })).changes[0].severity,
    ).toBe('compatible');
    expect(
      diff(withSchema({ type: 'integer' }, 'response'), withSchema({ type: 'number' }, 'response'))
        .changes[0].severity,
    ).toBe('breaking');
  });
  it('handles 3.0 nullable and 3.1 type arrays directionally', () => {
    const a = { ...withSchema({ type: 'string' }), openapi: '3.0.3' };
    const b = { ...withSchema({ type: 'string', nullable: true }), openapi: '3.0.3' };
    expect(diff(a, b).changes[0].severity).toBe('compatible');
    expect(diff(a, b).warnings).toHaveLength(0);
    expect(
      diff(
        withSchema({ type: 'string' }, 'response'),
        withSchema({ type: ['null', 'string'] }, 'response'),
      ).changes[0].severity,
    ).toBe('breaking');
  });
  it('follows array item variance', () => {
    const a = withSchema({ type: 'array', items: { type: 'string', enum: ['a'] } });
    const b = withSchema({ type: 'array', items: { type: 'string', enum: ['a', 'b'] } });
    expect(diff(a, b).changes[0].location).toContain('/items/enum');
    expect(diff(a, b).changes[0].severity).toBe('compatible');
  });
  it('marks additions to a closed response object breaking', () => {
    const a = { type: 'object', additionalProperties: false, properties: {} };
    expect(
      diff(withSchema(a, 'response'), withSchema(object(), 'response')).changes[0].severity,
    ).toBe('breaking');
  });
  it('marks optional response property removal compatible and required removal breaking', () => {
    const empty = { type: 'object', additionalProperties: false, properties: {} };
    expect(
      diff(withSchema(object(), 'response'), withSchema(empty, 'response')).changes[0].severity,
    ).toBe('compatible');
    expect(
      diff(withSchema(object(['id']), 'response'), withSchema(empty, 'response')).changes[0]
        .severity,
    ).toBe('breaking');
  });
  it('does not pass a lost promised response body', () => {
    const a = contract();
    const b = contract({
      paths: { '/items': { get: { responses: { '200': { description: 'Now empty' } } } } },
    });
    expect(diff(a, b).summary).toEqual({ breaking: 1, compatible: 0, warnings: 0 });
    expect(diff(a, b).changes[0].rule).toBe('media.removed');
  });
  it('does not pass removal of one negotiated response representation', () => {
    const a = contract({
      paths: {
        '/items': {
          get: {
            responses: {
              '200': {
                description: 'Success',
                content: { ...response.content, 'text/plain': { schema: { type: 'string' } } },
              },
            },
          },
        },
      },
    });
    expect(diff(a, contract()).changes[0].severity).toBe('breaking');
  });
  it('compares effective parameters with operation overrides', () => {
    const parameter = { name: 'id', in: 'query', required: false, schema: { type: 'string' } };
    const make = (required: boolean) =>
      contract({
        paths: {
          '/items': {
            parameters: [parameter],
            get: { parameters: [{ ...parameter, required }], responses: { '200': response } },
          },
        },
      });
    expect(diff(make(false), make(true)).changes.map((c) => c.rule)).toEqual([
      'parameter.required',
    ]);
    expect(diff(make(false), make(true)).summary.breaking).toBe(1);
  });
  it('compares header parameter names case-insensitively', () => {
    const make = (name: string) =>
      contract({
        paths: {
          '/items': {
            get: {
              parameters: [{ name, in: 'header', schema: { type: 'string' } }],
              responses: { '200': response },
            },
          },
        },
      });
    expect(diff(make('X-Trace'), make('x-trace')).changes).toHaveLength(0);
  });
});

describe('honest coverage', () => {
  it('marks unchanged nondefault or invalid parameter serialization incomplete', () => {
    const a = contract({
      paths: {
        '/items': {
          get: {
            parameters: [
              { name: 'q', in: 'query', style: 'deepObject', schema: { type: 'string' } },
            ],
            responses: { '200': response },
          },
        },
      },
    });
    expect(diff(a, a).status).toBe('incomplete');
    expect(diff(a, a).warnings.some((w) => w.message.includes('serialization'))).toBe(true);
  });
  it.each([
    { type: 'string', minLength: 3 },
    { type: 'string', format: 'uuid' },
    { type: 'string', readOnly: true },
    { type: 'object', properties: {} },
    { oneOf: [{ type: 'string' }, { type: 'integer' }] },
    { $ref: 'https://example.com/schema.json' },
    { $ref: '#/components/schemas/Missing' },
  ])('never declares unsupported schemas compatible: %j', (schema) => {
    const a = withSchema(schema);
    expect(diff(a, a).status).toBe('incomplete');
    expect(diff(a, a).warnings.length).toBeGreaterThan(0);
  });
  it('resolves local refs with escaped pointer tokens', () => {
    const a = {
      ...withSchema({ $ref: '#/components/schemas/A~1B~0C' }),
      components: { schemas: { 'A/B~C': { type: 'string' } } },
    };
    expect(diff(a, a).warnings).toHaveLength(0);
    expect(diff(a, a).status).toBe('compatible');
  });
  it('warns for reference cycles and siblings', () => {
    const a = {
      ...withSchema({ $ref: '#/components/schemas/A' }),
      components: {
        schemas: {
          A: {
            type: 'object',
            additionalProperties: false,
            properties: { child: { $ref: '#/components/schemas/A' } },
          },
        },
      },
    };
    expect(diff(a, a).warnings.some((w) => w.message.includes('Cyclic'))).toBe(true);
    const b = {
      ...withSchema({ $ref: '#/components/schemas/A', minLength: 3 }),
      components: { schemas: { A: { type: 'string' } } },
    };
    expect(diff(b, b).warnings.some((w) => w.message.includes('siblings'))).toBe(true);
  });
  it('bounds exponential local reference expansion', () => {
    const schemas: Record<string, unknown> = { Leaf: { type: 'string' } };
    for (let i = 0; i < 25; i++)
      schemas[`N${i}`] = {
        type: 'object',
        additionalProperties: false,
        properties: {
          a: { $ref: `#/components/schemas/${i ? `N${i - 1}` : 'Leaf'}` },
          b: { $ref: `#/components/schemas/${i ? `N${i - 1}` : 'Leaf'}` },
        },
      };
    const a = { ...withSchema({ $ref: '#/components/schemas/N24' }), components: { schemas } };
    expect(diff(a, a).warnings.some((w) => w.message.includes('10,000-node'))).toBe(true);
  });
  it('warns for unknown dialect, security, serialization and ambiguous parameters', () => {
    const parameter = { name: 'q', in: 'query', schema: { type: 'string' } };
    const a = contract({
      jsonSchemaDialect: 'https://example.com/dialect',
      security: [{ bearer: [] }],
      paths: {
        '/items': { get: { parameters: [parameter, parameter], responses: { '200': response } } },
      },
    });
    const report = diff(a, a);
    expect(report.status).toBe('incomplete');
    expect(report.warnings.some((w) => w.message.includes('Duplicate'))).toBe(true);
    expect(report.warnings.some((w) => w.location.endsWith('security'))).toBe(true);
    const make = (style: string) =>
      contract({
        paths: {
          '/items': {
            get: { parameters: [{ ...parameter, style }], responses: { '200': response } },
          },
        },
      });
    expect(diff(make('form'), make('spaceDelimited')).coverage).toBe('incomplete');
  });
  it('keeps detected breaking changes when coverage is incomplete', () => {
    const a = contract({ security: [{ bearer: [] }] });
    const report = diff(a, contract({ paths: {} }));
    expect(report.status).toBe('breaking');
    expect(report.coverage).toBe('incomplete');
  });
});
