#!/usr/bin/env node
// ============================================================================
// AFIP-S4A/S4B-1b — carrera REAL de preparación de rotación (2 escenarios).
// Cada backend usa una CLAVE DISTINTA con el MISMO subject mínimo autorizado
// (CN=<alias> + serialNumber=CUIT), derivado del certificado vigente.
//
//  A. Misma idempotency_key  → 1 ROTATION_PREPARED + 5 ROTATION_ALREADY_PREPARED.
//  B. Distinta idempotency_key → 1 ROTATION_PREPARED + 5 ROTATION_PENDING_CONFLICT.
//  Ambos: 1 pending, 1 secreto, 0 huérfanos.
//
// Solo DB LOCAL (docker). Fixtures SINTÉTICOS, se limpian al final.
//   node scripts/finance/arca-s4a-rotation-concurrency.mjs
// ============================================================================
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)

const CONTAINER = 'supabase_db_techrepair-vite'
const BIZ = '00000000-0000-4000-8000-0000000054b1'
const USR = '00000000-0000-4000-8000-0000000054b2'
const ALIAS = "fixture.alias"
const CUIT = "20111111112"
const SUBJ = "{\"cn\":\"fixture.alias\",\"serialnumber\":\"CUIT 20111111112\"}"
const CERT = `-----BEGIN CERTIFICATE-----
MIIB2jCCAUOgAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCBnzANBgkqhkiG9w0BAQEFAAOBjQAw
gYkCgYEAtdULzqwDVEeen9/aYHNqOty0uDnuno7WBskq9DIyKoh0fXbRpG5uqOXr
9u3g9OuvG4t040dV5yB2maKaRcRK05xc3Vw5f8nO1XjZEJcca484JlpbYP0R9amF
uKCaChr68EeUV55K3FBNmr6YxafS2FB9Sqm4D44jmekcJKkEJGsCAwEAATANBgkq
hkiG9w0BAQsFAAOBgQA7O44tjiUuaeQUab/wNcnkWh4sJqeNt70CGwTTNA2nyrSO
ic/msgA0P9de8+1gtJkDGQEvb4szJfoPWID5Klm8Sbu7c1qrDfyt8giukUpT9g5a
sZFjQHoaJUGB3BH4CSpmjX2ibQO22a31o9wDJGsgAdJlDYi+yHeehPIEzmONiw==
-----END CERTIFICATE-----`
const PAIRS = [{"key":"-----BEGIN RSA PRIVATE KEY-----\r\nMIICXQIBAAKBgQDrrBccpF69cyL0rKV64UFXYFVwtvVRvXkYWKynnKdPfhNzlbPR\r\n1izL8NmlrdF24iBCdpIY3B4n2wKxuta8KVwp0VtQqG3PYjNFddZEOOSBd8oo5QfL\r\n8OjBdGCYVaMSUId+rtJNFTEiHfDhko+AEBavRZGVQD71hmDVBKSpnaQazQIDAQAB\r\nAoGBAIYlVqJ/DU5ZEzSicS8YuNC7jOazvb/hUeSB1QUzLikZYokQVWLDvov3dGvS\r\nHMDGxgYO5+ouoRuellIEP+aqxEIRviqtB6BqhWqumKqT4MUTmzSk0+oW8Z4jcQYA\r\n4Z++24edYaj8o+DWSpcCpkeeAr2n9pob6b2EL8OXYRgnqSAhAkEA96CriVfZcmJR\r\nPD6GcDrKChVoz3NHpX0EwnT13l1Y78DDSBeAKXbO3ZU4ikTuSNI94S31NydiXmZp\r\nSCLnra7JUwJBAPOj8NykAVdffovPdQKBP5spW1eRArXY2A42rGPJCpJ+VDzG8dNR\r\nl8CG1JZWP2YF1NpXNBWVO1R3UgyE8eo9Z18CQQDhm1vNhOFTCmpSxfB8PcOnjjvw\r\njWogRxfYBvGfB1MpFGmWu/qDTIBKd1KM/yJN7GZ+Sv3XoyVHNm0DUPHdVpqLAkAm\r\nUTs5SCXZ2u/pBxiM60zYlzmBXRIDDXZ1Tc3w55ZdEbcn09YGeQeXxNy8RBY2cmZW\r\nbG6Jkm3BS/7Ab0wonb2bAkAJLViLCWhCS7pNUaa/FNDHTqKbt/U6ENTrpW5eKIzN\r\nXx+MdUGj3O3VE5bpHP5zDRPWsQdmitrefVbz9muHK0Ms\r\n-----END RSA PRIVATE KEY-----","csr":"-----BEGIN CERTIFICATE REQUEST-----\r\nMIIBcjCB3AIBADAzMRYwFAYDVQQDEw1maXh0dXJlLmFsaWFzMRkwFwYDVQQFExBD\r\nVUlUIDIwMTExMTExMTEyMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDrrBcc\r\npF69cyL0rKV64UFXYFVwtvVRvXkYWKynnKdPfhNzlbPR1izL8NmlrdF24iBCdpIY\r\n3B4n2wKxuta8KVwp0VtQqG3PYjNFddZEOOSBd8oo5QfL8OjBdGCYVaMSUId+rtJN\r\nFTEiHfDhko+AEBavRZGVQD71hmDVBKSpnaQazQIDAQABoAAwDQYJKoZIhvcNAQEL\r\nBQADgYEAKnIEJBkNn5ygsYeEsGX7Ol+hPnzd1M0lkCpUGgCTt6TGJaxNsrdAtO6s\r\n2yGeakaPsxmenjF2m+vXrPVg1V4MQ6V0oeWrWFREs/HHGgZEFnIteDZPgjxb7+k4\r\nHXXittfSshJmoWnol0/jydGbV7zf+KFp1wa+4Ugwd/Zx6VvU9nQ=\r\n-----END CERTIFICATE REQUEST-----","fp":"9a9bf989be5a887264f5278d9fffcf1e7d28d23832ffff99631d41ff62beca9f"},{"key":"-----BEGIN RSA PRIVATE KEY-----\r\nMIICXgIBAAKBgQDQ8vnHNeVwCTkkXzknSzSely6kbhRVq0gpevdWraB95fy3cSYx\r\nTGMusv0XcG2HhhdlJWM+uMWRD0khJC4XzSK78oaWu5RL136PmKWYFG7e3e6VA3TJ\r\n4ebNmg2cMwNexFH2SCzSHaIB4+G3fFWFsDPBdbaobb8UoeD8fhVUlWd0TwIDAQAB\r\nAoGBALc1BEtmd2k3vRGmKJ/KcjXHy07DcjL3fstYFTy7+mfJWz+hB2LcXm6Y5A9E\r\nNdVJfoPiN1XMfvZE19MmPQADjrpzetXz9eEzFl2Dic9jQih51W/H5eI0MwtoK2Yn\r\nuY3xg1elo5SKrSSZaYkrdYllj1vHQsCf8cjhCu/mEi4uV6qBAkEA/gdio4fGY89P\r\n9YHCoclNjRo2ICnH6wamCRG/EAwy+e895+v0jjwYFZMUioLAUnYoJYBu1CC0bK9+\r\nN82rj951jwJBANKSCrv36oBTUO6iNvbDVBg4QkNCsbFsxCxmF8KJlmLSjeyKpif3\r\ngdvAe4NZOYfq5pMH1c3WvMDMHDOD0w6bNUECQQDYZ0Y6dXImmPdO+EnsNWcha1Ds\r\nuWsb5sAPPdT8QMg0bwDX0AS4Hq2Nw4xeKuDX3tx4hh7kCzBo3l+x/j3HBAY1AkBh\r\nhwa1vMO+H9iyTiuK6zk95oC6Sl+mv6u0rKyAi909dCwLzMPcawSYVXRfh6nfy+pz\r\nWwOpzLWrzl2ZdosAjt6BAkEAhIBaGAk5g55i3ckuvoPi0F53iwwvP1TLelVVDG83\r\nchhn8JYFdgarwUuRwNflO5i/7uMRRA2nrOuXaQ4xCvjcBw==\r\n-----END RSA PRIVATE KEY-----","csr":"-----BEGIN CERTIFICATE REQUEST-----\r\nMIIBcjCB3AIBADAzMRYwFAYDVQQDEw1maXh0dXJlLmFsaWFzMRkwFwYDVQQFExBD\r\nVUlUIDIwMTExMTExMTEyMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDQ8vnH\r\nNeVwCTkkXzknSzSely6kbhRVq0gpevdWraB95fy3cSYxTGMusv0XcG2HhhdlJWM+\r\nuMWRD0khJC4XzSK78oaWu5RL136PmKWYFG7e3e6VA3TJ4ebNmg2cMwNexFH2SCzS\r\nHaIB4+G3fFWFsDPBdbaobb8UoeD8fhVUlWd0TwIDAQABoAAwDQYJKoZIhvcNAQEL\r\nBQADgYEALuYqCqZ0Esc6rlarHYwBVuaOCR3CcDnF+HB65SIeNzdWPA5pe4jXBcun\r\nEVzfaEe6tOTovorkM9Irl1UtYDAcneXJq2yg1vtw8qnyLqHn0ZPtwrjQUKjJ6/XB\r\nrB/yPs3pZIvwgDFFVgJhuN5k2ntZvoF6KDWXBGvPKtHfalmfxU0=\r\n-----END CERTIFICATE REQUEST-----","fp":"9b3a6d02f192eac6ee637b87e600d539640853a14a57040b8cd30a76682b7c72"},{"key":"-----BEGIN RSA PRIVATE KEY-----\r\nMIICXAIBAAKBgQCbpCC6RMT6bOCny4/JVXUrcZig2pPDg/5ciuI1fsbKFBxo3mUh\r\nuAdlMyjpNEDvDIxP+CgTwQORFKUiG8TpG26i+KLC420lBq6ElRwQ5SgLbWXGFBBA\r\nfwjmbnNYZLhWBrb7yxoCI8Po6sK9F6Do9XsKCfuXIeBjhrlpTpk9c7q4BwIDAQAB\r\nAoGAELisb3at9v21kTF0jDvrL7SvojB5iZrnvAeL0BWDw/gvKTEjimDcIopBjfR4\r\nOXaOqJTPsXeeK3sdVrHHEQhKdXr7C6AuosH6fl+obxxrxfU4gzQRDD0gQlqUXmXP\r\n+tJg4ph/T81iCRd/bF8J5NXpe5DtZRS8ozCiqmU2FzdtH7kCQQDCaUo2YgxZGS2x\r\n0laEERY8KZjcskx53XuAwseisIoevPPVSjAzVg69JA9wPW31j75uaOjK+ZCaCQqJ\r\nLqvZdkjTAkEAzPKWMNVTDCSBmoFdanlwaVGvd7Zdq+2Eo8h0LHAfTKn4fnNG4Q4t\r\nBQ+4ufVIUrIfWDO/rXs96umiOHkiCTiTfQJAZCiil0oEWpLiO87Fy9yRvAUiP/GL\r\n/Ozih//RojuZrSRj6usB0jDv/vnpCkZbtDuOPIvIA2p32SP3TZ3B45NRCQJAGdCo\r\nqGgGeO4UQSDwYlv/k9SNNJgM/n4BihvSvlI1LxPt0Ae3Mtv1QcD0NMA3pur21cZW\r\n64QtjWx2WYSwi9bLhQJBAJ/Cf3kDfx+VuP7zcPLJPrMfl2+cDk+nouINQEBsyCQ/\r\n9erN9tixFZXg/px9WOGm1VLOfDgjHpWSO9DVrZcUnp4=\r\n-----END RSA PRIVATE KEY-----","csr":"-----BEGIN CERTIFICATE REQUEST-----\r\nMIIBcjCB3AIBADAzMRYwFAYDVQQDEw1maXh0dXJlLmFsaWFzMRkwFwYDVQQFExBD\r\nVUlUIDIwMTExMTExMTEyMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCbpCC6\r\nRMT6bOCny4/JVXUrcZig2pPDg/5ciuI1fsbKFBxo3mUhuAdlMyjpNEDvDIxP+CgT\r\nwQORFKUiG8TpG26i+KLC420lBq6ElRwQ5SgLbWXGFBBAfwjmbnNYZLhWBrb7yxoC\r\nI8Po6sK9F6Do9XsKCfuXIeBjhrlpTpk9c7q4BwIDAQABoAAwDQYJKoZIhvcNAQEL\r\nBQADgYEAWWLAlQD33qSAcqFGvzd+AuQX4hjaD711ILqtN1di5ymIG9RWs4zJYwuK\r\ncTiPQmTEuVNWhhOWvkZYqQ1PCvVzmD0RnAzXDQAK/a+MGBw3984E9obV9+O223TL\r\nPLFNAp5NNIyDrdgfBQjyTlDSpyZ8+eFmPREltIID1SFx9IYbNrc=\r\n-----END CERTIFICATE REQUEST-----","fp":"33eacec8df4a492f0b03f8c9e051dd19f513a255df1a65fed7d0ed5930c0e503"},{"key":"-----BEGIN RSA PRIVATE KEY-----\r\nMIICXgIBAAKBgQD0RzyrfjyvaDrvVFjedM0f7LTpYaRL7kLv6Mftv0SZttWjoGL8\r\nQoD28fwaJNIQgOD65wEUyQpoIOLz5VYk45TAPLuA8eWsoTtWaQpy8jN+V2Wh/uKC\r\nDLtHVdLpog3TXyg1m2AtydZuZJL1FDhiSGm464tTnuQPL3OdyTTyhwgchwIDAQAB\r\nAoGBALgMXFfRuyNl4tGjuXmSg2KEVCJrIQDcua5MsyYcMDGoofqwwyPRb52f4RRJ\r\nncQ1dk1Uc2oXtzGRZa3hozAUEGP2CFfToEmg7CNGRyaa+yb1Yyqg7M2ZFbwMERQT\r\nh42oXWPFNB66FtmSqEw/aZq7euXzLjy3O88cwA8SzI5aGJ7RAkEA+MA8jmnuLQmO\r\na0DPy9AqgbkKYiwNTVqwKfYzft50aOkxcm59HYHVii51GgEy9VCfR1O42JoGBKo5\r\nZEphFh37WwJBAPtlogqe23MeBvsW6a3cMFFtbJyKFZzXdxHpwUKdiQoo2L3tI3Tx\r\nBoH6FAmn39HnAAo/QeeaH8TFPtf49vXhp0UCQQC0gpvvJMPn/tVQ03l3h5oxBNya\r\nHSmSBstrx/Pajwee0gpF5hP5A6y4V7o2osQd7OGI2yJ6XFsdq4F2W9tUN3GdAkEA\r\n0/KytAuMbriRIB4IM2lhXzVHDY8pe4r4uyR9qEES6XrYiP+mFhCi8PA69o0PGXOM\r\nyBbe5Hk/cXDuc71V0KVHlQJACodh95a/+9erYFb0/WargKF/WeyLwlTqCWOtnIvy\r\nHorwuz1lod324vk8lK90h+2lKfFHujDGkPLeq3CdKq54MQ==\r\n-----END RSA PRIVATE KEY-----","csr":"-----BEGIN CERTIFICATE REQUEST-----\r\nMIIBcjCB3AIBADAzMRYwFAYDVQQDEw1maXh0dXJlLmFsaWFzMRkwFwYDVQQFExBD\r\nVUlUIDIwMTExMTExMTEyMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQD0Rzyr\r\nfjyvaDrvVFjedM0f7LTpYaRL7kLv6Mftv0SZttWjoGL8QoD28fwaJNIQgOD65wEU\r\nyQpoIOLz5VYk45TAPLuA8eWsoTtWaQpy8jN+V2Wh/uKCDLtHVdLpog3TXyg1m2At\r\nydZuZJL1FDhiSGm464tTnuQPL3OdyTTyhwgchwIDAQABoAAwDQYJKoZIhvcNAQEL\r\nBQADgYEAspKnuS9r9w6RshgLywo+ZNZL+oeFnpaxLZnYVWamkQ6ilcM8vCSr4bqO\r\nc69nwZfnAZtJiAAyvzFQy7pnw8UhZrrQZ4/iAz12tDTl2qZ4RHd2BuD5vBRkQ9Ob\r\nLwfvEYy3rKl1DEfTcY94R/Sv7T30k39cqJxh4tmySNUgwJmP4xs=\r\n-----END CERTIFICATE REQUEST-----","fp":"cfe053ed5aed8600ee9897b615160c2dbae42ae1f3932c51506eeb4b4c9ba9f9"},{"key":"-----BEGIN RSA PRIVATE KEY-----\r\nMIICXQIBAAKBgQDoPcVCxi3QTUJA+1Rd/UxNaxdS5UCigOMbBCV4ckW4Xabc9TZ/\r\n1iD6QngiWBl/wLUUTLAnoK2k8+/P1JCGo9EF+ZPtNcQrbjkhYAXcVD3cZNgTgjnC\r\nb3N5Bnnb7RMXVD9Gx4qIpQac6MlGUdTOtEUOfxnqgFTTkqRkdV7VvWjFrwIDAQAB\r\nAoGAeOnYLxjRN3dR/FUeKsU7Gb+c6BrV2QVzuFgjTh9or0GLI9VDZ7FLgCBlPbRS\r\nqlHhtUzsFeWxIoWioLkR+heGNjEQRqOTziwzMfTcO5pEjnLnR1hvtd2xSjeIUuAO\r\ndwOy3phUSAmKhE/Nm504H2rMoC3UiX5nw+Fn4BAYhO50wYECQQDqg9J2RFPzQNUu\r\ntQO05r3mavynyI4BYiRVN9NqampjfUl9/u9wrdno1BCyv64NHGTmxlmdIRb0QL8T\r\n801iKGTvAkEA/YSfsnqVjdJLk7ZiZ+yRV4bQb1sIMs14MGb+/JFhDJ+rd/7aM6jq\r\nDnnoInyq7bLx8p+p3U2S8JsUfQh9OP0rQQJAfpozoE061POHIvPt0FdQ5XeUdi+7\r\nGdwVqTu+EpDoZlVYu4BJWxc/sIXrjdQU7lcJ0dv6vO0EK1BY1zhd6kPMWQJBAK7J\r\nQVFMMtAUrQaqOC5ua8ZsrEgZ+w0LnFHCsQpxMPgDHbUdgFMdokFYyzL7wN0hAq7E\r\nZdiuIyC/yuBpeexQoAECQQDMmhW5Hak3oUBY3gCuUBM1koHbxfdNoKXk9RctlErA\r\ntYqpPVvTJM+obJ2GqA1jqsOlGbw4Y/kIATE1X0JrjV8o\r\n-----END RSA PRIVATE KEY-----","csr":"-----BEGIN CERTIFICATE REQUEST-----\r\nMIIBcjCB3AIBADAzMRYwFAYDVQQDEw1maXh0dXJlLmFsaWFzMRkwFwYDVQQFExBD\r\nVUlUIDIwMTExMTExMTEyMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDoPcVC\r\nxi3QTUJA+1Rd/UxNaxdS5UCigOMbBCV4ckW4Xabc9TZ/1iD6QngiWBl/wLUUTLAn\r\noK2k8+/P1JCGo9EF+ZPtNcQrbjkhYAXcVD3cZNgTgjnCb3N5Bnnb7RMXVD9Gx4qI\r\npQac6MlGUdTOtEUOfxnqgFTTkqRkdV7VvWjFrwIDAQABoAAwDQYJKoZIhvcNAQEL\r\nBQADgYEAl3lwMgvj2V3E9mKb0a92dqY54QrF/gdxHp6okwSDTGziGW4liO9NAMSV\r\njgeRcayBAkTkb6dchKibmUPT/2Yz1emI1+TT35Ub4HkfafDOIMEo/4thDRzX39+O\r\nDdP60mxUvHrjrgtl5zJV4w5EheW/aszTM12pOQb6tVdN/Jzv0kA=\r\n-----END CERTIFICATE REQUEST-----","fp":"da373934733657700ba779b749ac8444952f97f5c3bf02d03a068796a2216b1d"},{"key":"-----BEGIN RSA PRIVATE KEY-----\r\nMIICXQIBAAKBgQDRFohe69JF7gnt7rmolPEyUgLNxVMJ01mRcDAbbUWn8NP3OQLc\r\nUcaBicdfi49k5TsI80BwmM5PuOaA86OnfGQY7upN6ywCjwnqzG0/fWuUo1Xx5Tgb\r\nhJlFafWX61VJHs+FhBl+9SVHWZxrtmao1Xh3BrhBfb9yCD+EpR2KdseyEQIDAQAB\r\nAoGAE15p/ZkM3ouBgfgGXNaHTWkJd3RbD+LzPiTNYA0MUdVeXV17pVsx71gLDw/H\r\nlcoiYN7fzk5pdjsjpzhqpZ5BS18STGvnBkOXahfJPgPAae8B7kmdiftTxTvIOxEM\r\nAl3M2dzoK58nXZpBuKMF4lz0qMdMHh2UmtN/rXwnTtbv960CQQDzvtNepBb3fMBk\r\nZJK1D+fILXyXIUw602kWYt3mjKn9xtOsJbtZoHsXENwY5wB4RStrBCkM07uR5KQi\r\nTU0/lhNjAkEA25mkXu3KVoAQl1/CdQRGXvARTWv2mBa28U2JLULuv+mhnoS22/OV\r\nKacPDoc7SHPzGZ7eIsu7hKDrD133CcmQ+wJAWJ8FEt/uScVd3iKDBLnnt+xx5DED\r\nGlBLYQxJSc3S8KYdx/VgDNJAbr5+h79VeGUNyDcXBcbl58GNu7sHXxsdqQJBAJnT\r\nBuukH+71qCmQ33L+epi4CzazYLnqd12SFXwJ/Zma+yZCCqEKADt8FTT1D1bSOcCB\r\no1K2aXUfD2jlRk2pzw8CQQDRyz5xAw6MaiQJjIWE6bg+c7sR0F/QUyG4VVOA2AT8\r\nDHC48BXMPcnizwEWKs85GMR4UkyYnDTkPIIADoY6/w6L\r\n-----END RSA PRIVATE KEY-----","csr":"-----BEGIN CERTIFICATE REQUEST-----\r\nMIIBcjCB3AIBADAzMRYwFAYDVQQDEw1maXh0dXJlLmFsaWFzMRkwFwYDVQQFExBD\r\nVUlUIDIwMTExMTExMTEyMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDRFohe\r\n69JF7gnt7rmolPEyUgLNxVMJ01mRcDAbbUWn8NP3OQLcUcaBicdfi49k5TsI80Bw\r\nmM5PuOaA86OnfGQY7upN6ywCjwnqzG0/fWuUo1Xx5TgbhJlFafWX61VJHs+FhBl+\r\n9SVHWZxrtmao1Xh3BrhBfb9yCD+EpR2KdseyEQIDAQABoAAwDQYJKoZIhvcNAQEL\r\nBQADgYEAVpH7deHtFJ6VOrFGF4BoFepVHbqm7OgIFCY8FB6h+P7vXCh1wEvYnd5P\r\ntfqUx/XpHogiPTUvgLuA/+6nuAoi7hLxxw3ScysyF2D0JlXx/e7P4vkKlaSKgR0f\r\nVR5YGN7tVG5Kp9Z6O3L2z4eYMwoQ7w5V9r2RiUGzLTCaUaDgcB8=\r\n-----END CERTIFICATE REQUEST-----","fp":"d1bc5d09906ad78cc0c3ec7317b30705eeb5d6fe4b6382616eeaf727192276d4"}]

async function psql(sql) {
  const { stdout } = await exec('docker', ['exec', '-i', CONTAINER, 'psql', '-X', '-t', '-A', '-U', 'postgres', '-d', 'postgres', '-c', sql], { maxBuffer: 20 * 1024 * 1024 })
  return stdout.trim()
}
const call = (p, idem) => `SET request.jwt.claims = '{"role":"service_role"}';
  SELECT public.arca_prepare_certificate_rotation('${BIZ}', $k$${p.key}$k$, $c$${p.csr}$c$, '${p.fp}',
    'RSA', 1024, 65537, $j$${SUBJ}$j$::jsonb, '${idem}', '${USR}')->>'state';`

async function cleanup() {
  await psql(`
    DELETE FROM vault.secrets WHERE id IN (SELECT private_key_secret_id FROM private.arca_credential_rotations WHERE business_id='${BIZ}');
    DELETE FROM private.arca_credential_rotations WHERE business_id='${BIZ}';`)
}
async function invariants() {
  const pending = Number(await psql(`SELECT count(*) FROM private.arca_credential_rotations WHERE business_id='${BIZ}' AND state='pending_rotation';`))
  // AFIP-S4C: los conteos se filtran por NEGOCIO. Antes eran globales y cualquier
  // otro harness que dejara datos de prueba los contaminaba (y hacía fallar éste
  // según el orden de ejecución, sin que hubiera ningún bug real).
  const secrets = Number(await psql(`SELECT count(*) FROM vault.secrets s
    WHERE s.id IN (SELECT private_key_secret_id FROM private.arca_credential_rotations WHERE business_id='${BIZ}');`))
  const orphans = Number(await psql(`SELECT count(*) FROM private.arca_credential_rotations r
    WHERE r.business_id='${BIZ}' AND r.private_key_secret_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM vault.secrets s WHERE s.id = r.private_key_secret_id);`))
  return { pending, secrets, orphans }
}

let fail = 0
const check = (c, l) => { c ? console.log('PASS: ' + l) : (fail++, console.log('FAIL: ' + l)) }

async function main() {
  console.log('AFIP-S4A/S4B-1b — carrera de preparación de rotación\n')
  await psql(`
    INSERT INTO auth.users (id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
    VALUES ('${USR}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','s4a-race@test.local','',now(),now())
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.businesses (id,name,owner_user_id,subscription_plan,subscription_status)
    VALUES ('${BIZ}','S4A-race','${USR}','pro','active') ON CONFLICT (id) DO UPDATE SET owner_user_id=EXCLUDED.owner_user_id;
    INSERT INTO public.arca_config (business_id,cuit,alias,ambiente,punto_venta,web_service,cert_file,estado_conexion)
    VALUES ('${BIZ}','${CUIT}','${ALIAS}','homologacion',1,'wsfe',$cert$${CERT}$cert$,'conectado')
    ON CONFLICT (business_id) DO UPDATE SET cert_file=EXCLUDED.cert_file, alias=EXCLUDED.alias, cuit=EXCLUDED.cuit;`)

  // ── Escenario A: misma idempotency_key, claves distintas ──
  await cleanup()
  let states = await Promise.all(PAIRS.map((p) => psql(call(p, 'race-same'))
    .then(o => o.split('\n').filter(Boolean).pop()).catch(e => 'EXC:' + String(e.message).slice(0, 50))))
  console.log('A estados:', JSON.stringify(states))
  let inv = await invariants()
  check(states.filter(s => s === 'ROTATION_PREPARED').length === 1, 'A: 1 PREPARED')
  check(states.filter(s => s === 'ROTATION_ALREADY_PREPARED').length === 5, 'A: 5 ALREADY_PREPARED')
  check(inv.pending === 1 && inv.secrets === 1 && inv.orphans === 0, 'A: 1 pending / 1 secreto / 0 huérfanos')

  // ── Escenario B: distintas idempotency_key ──
  await cleanup()
  states = await Promise.all(PAIRS.map((p, i) => psql(call(p, 'race-diff-' + i))
    .then(o => o.split('\n').filter(Boolean).pop()).catch(e => 'EXC:' + String(e.message).slice(0, 50))))
  console.log('B estados:', JSON.stringify(states))
  inv = await invariants()
  check(states.filter(s => s === 'ROTATION_PREPARED').length === 1, 'B: 1 PREPARED')
  check(states.filter(s => s === 'ROTATION_PENDING_CONFLICT').length === 5, 'B: 5 PENDING_CONFLICT')
  check(inv.pending === 1 && inv.secrets === 1 && inv.orphans === 0, 'B: 1 pending / 1 secreto / 0 huérfanos')
  check(!states.some(s => String(s).startsWith('EXC:')), 'sin excepciones')

  await psql(`
    DELETE FROM vault.secrets WHERE id IN (SELECT private_key_secret_id FROM private.arca_credential_rotations WHERE business_id='${BIZ}');
    DELETE FROM private.arca_credential_rotations WHERE business_id='${BIZ}';
    DELETE FROM public.arca_config WHERE business_id='${BIZ}';
    DELETE FROM public.businesses WHERE id='${BIZ}';
    DELETE FROM auth.users WHERE id='${USR}';`)
  console.log(fail === 0 ? '\n✅ concurrencia S4A/S4B-1b OK' : `\n❌ concurrencia: ${fail} fallo(s)`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch(e => { console.error('harness error:', e.message); process.exit(1) })
