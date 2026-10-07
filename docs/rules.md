# Rule reference

Comparison is **baseline → candidate**. The baseline represents the contract existing clients know. A breaking finding means the candidate can violate a structural promise; it does not claim that a particular running client has failed.

The engine uses a conservative model: request senders must keep their valid choices, while response consumers must not encounter new undeclared cases.

| Change                                      | Request/input | Response/output                                                             |
| ------------------------------------------- | ------------- | --------------------------------------------------------------------------- |
| Add a possible primitive type               | Compatible    | Breaking                                                                    |
| Remove a possible primitive type            | Breaking      | Compatible                                                                  |
| Expand enum values                          | Compatible    | Breaking                                                                    |
| Narrow enum values                          | Breaking      | Compatible                                                                  |
| Make an existing property required          | Breaking      | Compatible                                                                  |
| Make an existing property optional          | Compatible    | Breaking                                                                    |
| Add optional property to closed object      | Compatible    | Breaking: baseline forbids extra keys                                       |
| Add required property to closed object      | Breaking      | Breaking: baseline forbids extra keys                                       |
| Remove optional property from closed object | Breaking      | Compatible                                                                  |
| Remove required property from closed object | Breaking      | Breaking                                                                    |
| Add media type                              | Compatible    | Breaking: new possible representation                                       |
| Remove media type                           | Breaking      | Breaking: clients can lose their negotiated representation or promised body |

`integer` is treated as a subset of `number`. Empty schemas are unconstrained. Primitive enum values are compared as values, not display strings. For OpenAPI 3.0, `nullable: true` adds the null type; for 3.1, use a type array including `null`. `nullable` in 3.1 produces a warning.

## Operations and parameters

- Removing a path or method is breaking. Adding an operation is compatible within the supported structural model.
- Path-item parameters are inherited; operation parameters override the same `in`/`name` pair. Header names are compared case-insensitively.
- A new required parameter or request body is breaking; a new optional one is compatible. Removing a parameter or request body is conservatively breaking because the candidate no longer declares support for what existing callers send.
- Duplicate parameters, missing path parameter declarations, and ambiguous path templates produce warnings.
- Parameter serialization changes produce warnings. Serialization options outside the supported shape are not interpreted as schema constraints.
- Adding a possible response status is breaking; removing one narrows the declared outcomes. This says nothing about business success rates. `default` and status ranges produce warnings because coverage relationships between them and explicit statuses are not computed.

## Coverage is separate from severity

`status` is `breaking` if a breaking change is found, `incomplete` if only unsupported constructs remain, and otherwise `compatible`. `coverage` is independently `incomplete` whenever a warning exists, including alongside a breaking result.

The normalizer visits used operation schemas on **both sides**, including added or removed operations. Thus unchanged unsupported constructs still prevent a complete compatibility verdict. Unreferenced component schemas are outside the affected operation graph and are not audited.

Examples of incomplete coverage:

- `additionalProperties` omitted, true, or itself a schema: open objects need property-fallback reasoning that is outside this version.
- `oneOf`, `anyOf`, `allOf`, `not`, discriminators, conditionals, patterns, bounds, and formats.
- Authentication and authorization declarations, server URLs, response headers, callbacks, webhooks, and other unhandled operational fields.
- External refs, unresolved local refs, cyclic refs, semantically relevant `$ref` siblings, or a reached expansion budget.
- Unknown schema dialects or malformed supported declarations.

Annotations such as descriptions, titles, examples, defaults, deprecation, tags, operation IDs, and vendor extension fields are not behavioral compatibility rules. XML serialization annotations are outside scope and produce warnings. Generated client names, documentation meaning, authorization behavior, runtime implementations, and business rules require separate review.

## Deliberate limits

Constraints are checked independently rather than by a complete satisfiability solver. For example, changing `type: integer` to `type: number` with an unchanged enum of integers is conservatively reported as a widened response type even though the enum still limits the values. This favors visible review work over an unsupported proof of equivalence.

A closed response object (`additionalProperties: false`) explicitly forbids additional keys. Adding an optional field to that schema is therefore reported as breaking. Systems whose clients deliberately ignore unknown fields need a different policy; this version does not silently assume it.

This tool does not verify that a service actually implements either contract. A complete report means all encountered comparison rules were supported, not that the deployment is safe.

Reference: [OpenAPI 3.1.1 specification](https://spec.openapis.org/oas/v3.1.1.html).
