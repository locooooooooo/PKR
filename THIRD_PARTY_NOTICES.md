# Third-party notices

The locked dependency tree used to build and test this candidate contains the
following packages. Their licenses apply to those packages, not to PKR as a
whole.

| Package | Locked version | License | Use |
| --- | --- | --- | --- |
| `ajv` | 8.20.0 | MIT | Runtime JSON Schema validation |
| `fast-deep-equal` | 3.1.3 | MIT | Transitive `ajv` dependency |
| `fast-uri` | 3.1.4 | BSD-3-Clause | Transitive `ajv` dependency |
| `json-schema-traverse` | 1.0.0 | MIT | Transitive `ajv` dependency |
| `require-from-string` | 2.0.2 | MIT | Transitive `ajv` dependency |
| `typescript` | 5.9.3 | Apache-2.0 | Development compiler |
| `@types/node` | 24.13.3 | MIT | Development type declarations |
| `undici-types` | 7.18.2 | MIT | Transitive type declarations |

The authoritative versions are in `package-lock.json`. Full license texts are
included by each installed dependency and remain available from the linked
package source metadata in the lockfile.
