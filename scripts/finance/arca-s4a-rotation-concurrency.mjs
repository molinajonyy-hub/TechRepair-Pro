#!/usr/bin/env node
// ============================================================================
// AFIP-S4A/S4A.1 — carrera REAL de preparación de rotación (2 escenarios).
// Cada uno de los 6 backends genera/usa una CLAVE DISTINTA (mismo subject S_A).
//
//  A. Misma idempotency_key  → 1 ROTATION_PREPARED + 5 ROTATION_ALREADY_PREPARED,
//     todas refieren al MISMO CSR/fingerprint, 1 pending, 1 secreto, 0 huérfanos.
//  B. Distinta idempotency_key → 1 ROTATION_PREPARED + 5 ROTATION_PENDING_CONFLICT,
//     1 pending, 1 secreto, 0 huérfanos.
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
const SUBJ = "{\"c\":\"AR\",\"o\":\"Taller S4A Uno\",\"serialnumber\":\"CUIT 20111111112\",\"cn\":\"Taller S4A Uno\"}"
const PAIRS = [{"key":"-----BEGIN RSA PRIVATE KEY-----\r\nMIICXAIBAAKBgQCudJI8P1nWQZZVUppfnAuXt2RYSLu1anB55wGzVGGXVp8+K/ap\r\n6lKMyjrfITchM67LroUBmimigIqZYflGJ9Kpy58gXUKo7Ud5dPQz3e/gB7wreXnV\r\nQY5i/fFmM368E3tWqJWhEm0gnMY/JPZLTbD9suR0bo73rTzNHoGQGeAMxQIDAQAB\r\nAoGAKpEpCWhPzFaujt0b685QidFmu5/rpUV2clgqcw5YzauGKY5inm0dfVru6Hjb\r\nUc+hi/NmYtCx7gO9TdW5FCQtY3e40wUFOR4RYVEA6Xg12lLgplgVQjhFVA2E8GFK\r\n9LS/qKflzq0Hn0n1JL5Wl7Nw/e9jHsc4CfbsFt9vZURH3XUCQQDSGldJXJKHrKmw\r\ncRSpA+BcOWEGivFXUYGyYrIhg60T+47HOFybYns3iyYfaV22Iv6zdWcYj4Jhke3s\r\nc5XWv1qXAkEA1JCzRqS4c45+mIgkIrLOVaOW9+DYdcePlm6CynJ0KeayOizEWPjO\r\nk8tLrrZXv0cmdDPdOTNbP+JMXljjdF6LAwJAGMS+MYnWRGRYhNJv6xTn6Ddjds/+\r\nb5rOPWdhNI4/YzGuvVGpqS/M8tlWnzFeuNAbUrCufLi+WB5J/CwMKAra9QJBAIEq\r\nrMXwsmUF4ceucsbjAJ7pmYNnDiID8iznWnLKuev8U7EmIuotxtnoX0T7aLbC9YsH\r\nORbZLknTqbRrL0w3ZyECQAL8+SUbF4gFPQzJn/jntqexyDpXu7QEc4aUILPH4W+F\r\nc7EgXpN0qn66bvmod12Z/KiatVNT1Wzea8QBO8u//7k=\r\n-----END RSA PRIVATE KEY-----","csr":"-----BEGIN CERTIFICATE REQUEST-----\r\nMIIBmjCCAQMCAQAwWjELMAkGA1UEBhMCQVIxFzAVBgNVBAoTDlRhbGxlciBTNEEg\r\nVW5vMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMRcwFQYDVQQDEw5UYWxsZXIg\r\nUzRBIFVubzCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEArnSSPD9Z1kGWVVKa\r\nX5wLl7dkWEi7tWpweecBs1Rhl1afPiv2qepSjMo63yE3ITOuy66FAZopooCKmWH5\r\nRifSqcufIF1CqO1HeXT0M93v4Ae8K3l51UGOYv3xZjN+vBN7VqiVoRJtIJzGPyT2\r\nS02w/bLkdG6O9608zR6BkBngDMUCAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4GBAJK4\r\n0ATV6F0MJlMzBe4EKbn5UB7EM9YzBTn8YcvKDTV+FJMyqm64tK1GAW7fxTht+acL\r\nGudlaQ51TEO1S4m7+u18/GlZYTu47fvsgiifyqClQTyiquU04+VAZ6cR3G9AL0Fh\r\neULafb8QGjCwRhCzhdCMdBqDi1CAqux/OEemmanD\r\n-----END CERTIFICATE REQUEST-----","fp":"fd624265a345479fbf3bdc8cb8db009edcc2179a738e1a913490884bd4038489"},{"key":"-----BEGIN RSA PRIVATE KEY-----\r\nMIICXQIBAAKBgQDM0aN1b7WfuEwVCUY9ZE6zsxatt3iOuzwOcETw6ZOgGnylH9NN\r\nsYApM5fUmgYVDl61J2lzwBbdqu7ULU6MrZMCU9QDxVp2kgz5F690AyERIpUhcn1C\r\ntFPZSuRqyJUauLB75YklO457lZBRCI/jYAj7r8q1EYfFvSGRECvU/vKd6wIDAQAB\r\nAoGAAw2pAyosKfpkX/fobSfeqH0l/Gb8zBvsdEamMHU69ysN6qRD0SexQmv7enbl\r\nWlEBhm/U+Z3GeX1/2/fk8OHxjBOCDfqWS3NL41kT7cz3i5D8pr9RR3noib9zY/Y4\r\nFB1DWzqWoBqAYHc/B+7uDQL26FkM8mvqw+xl1P9oqFgyOYkCQQDk3rYE22wcm68m\r\nhhv/j2LB6PvM5m56YWhpkr5Jp1rgtpN29JwsQMvYkotlEhtK1sUzWsBfWskUm5n6\r\nL4T+x+qNAkEA5RkS48xUMgNUsa2y9uazN3ora2mNbhYqqPJzNtxeR7z9JYNShmZT\r\nV3TydJe8z8e/iXYe6vyNxz6XHvwdd8OIVwJBAJQ87AgZVtzwuXFqS5grdvvBu9Xr\r\nKoN5s/ctZLKwAtypZLoXlU/UaDPONxsvrx26HeA1V4RrePIwFntFbA7ZzcECQQCe\r\n5bArXVn8QkEo5y/cfZBJ5ytcWZ5lf2xhN5/fqiKeIR93OEkxvKELZKqRYXjsqD9Z\r\nyRqSo052phvMutJ5cZ4LAkA3baaYOCrlfWrRAI1sUBJXtjMEDo0vM+dwxLbykbUG\r\nTgzngQo1ChPnS546lPebfxJQ+50TjvxP/JGAzGIOowFD\r\n-----END RSA PRIVATE KEY-----","csr":"-----BEGIN CERTIFICATE REQUEST-----\r\nMIIBmjCCAQMCAQAwWjELMAkGA1UEBhMCQVIxFzAVBgNVBAoTDlRhbGxlciBTNEEg\r\nVW5vMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMRcwFQYDVQQDEw5UYWxsZXIg\r\nUzRBIFVubzCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAzNGjdW+1n7hMFQlG\r\nPWROs7MWrbd4jrs8DnBE8OmToBp8pR/TTbGAKTOX1JoGFQ5etSdpc8AW3aru1C1O\r\njK2TAlPUA8VadpIM+RevdAMhESKVIXJ9QrRT2UrkasiVGriwe+WJJTuOe5WQUQiP\r\n42AI+6/KtRGHxb0hkRAr1P7ynesCAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4GBAHax\r\nrAnvI9aLpUFNQhXpih6Poi9v7MJlXANkf+UczysKpYmgEiaBy372GK3uk7/9NI3X\r\n83+FKnJ7V+C1ug2U5HnOm0usijlkZ7RBTWNBn4WuwBSuneHBv8AIJ+p7JUT0yum1\r\nmxPZ+QNgfEWbeKHVdgbRb70/qEkuZee6g9m2j0HJ\r\n-----END CERTIFICATE REQUEST-----","fp":"c0dd986971d6836cd16508f1f3d2565ec3f7f1db463d500a28b750831680d20a"},{"key":"-----BEGIN RSA PRIVATE KEY-----\r\nMIICXQIBAAKBgQC43diRLvlLbtjKdhX2kZbvhHCbNDYwnTQeNH2QzhCYPrRtneQM\r\n0VkyF/VoG5avbSjUdl77I8nColRsiTeddRH2ubVNcPsWGKVPfI7YGpdVS2QdJKo8\r\n/TnNQC9mDsefPkZv2pPnr2IVBo4xX+Fk5F9SZTOw7r44KGofqUI3TRS+wwIDAQAB\r\nAoGBAJQCkp0S5ee+NPZMeyMxx423FM0+jVB43Lx+PDZOtbyfH6hP7MFSb76KriIP\r\nTKLhm/oXV85tBeG+RCet6Qg5Lgpj9YIH5dEi4C6WZG/ZZvm0Vah6mPGrV21pxVIO\r\nrq3abUIYWHhC8tCYxe3sRW9rplc74UqKsGrn4Fsa/K3LfhFRAkEAwCfhB0cz42Dy\r\n8Ntu2YVdqa5lfze3WkNBYGTvjfTcqRvyCNsz8zGxSgcr+vW77YsgvkVN0EFDkpSk\r\nSyAThpvYmwJBAPZJ+RL2MoBbPcCT/C1/ODyCneiuY7eYbJM+EaWaAttKJySTrFsv\r\nyC4Ydk4nZ0oBWn39ar6w/t5Y9oxSpE3GMPkCQGcswnn69FRxeOB0oidvoaP7PQo6\r\n61su44qTh8DsKhMvKx0wPcul8fCyux2sFjTs0C753Vclw9ePskuYNIPBaGMCQECU\r\n2yQ2vL1dr46s/2ZqwrNTSNb3y5wb8vSVRQlYnkEka6kys/JhUCuOLI+H05TbUABT\r\nkEcaoGprh5L6JK1kN/kCQQCqtL3NTuEyAv5XbyzjQAh0NEt4Z8pUvfEwWx0UzYCK\r\nJsUQcvkjUenXJCYLUPMNGSZEYq/r188eio3k80Reaux5\r\n-----END RSA PRIVATE KEY-----","csr":"-----BEGIN CERTIFICATE REQUEST-----\r\nMIIBmjCCAQMCAQAwWjELMAkGA1UEBhMCQVIxFzAVBgNVBAoTDlRhbGxlciBTNEEg\r\nVW5vMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMRcwFQYDVQQDEw5UYWxsZXIg\r\nUzRBIFVubzCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAuN3YkS75S27YynYV\r\n9pGW74RwmzQ2MJ00HjR9kM4QmD60bZ3kDNFZMhf1aBuWr20o1HZe+yPJwqJUbIk3\r\nnXUR9rm1TXD7FhilT3yO2BqXVUtkHSSqPP05zUAvZg7Hnz5Gb9qT569iFQaOMV/h\r\nZORfUmUzsO6+OChqH6lCN00UvsMCAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4GBACOX\r\ngmBdIzkDrCuwRweM8X4E/9YbOYfVkkhvXCvwLg2pCmGj1k8+q3PDxTYBByWPDuY6\r\nzdGjdxurh5EFeQOpL6HitM+IfZ22M1zJKph2IY+qsLzilM9f1BHJ3aeCmRBKE9gV\r\nSlbiXE5dkNnySim4VaRBJix/RCAQzizg/+EX+FYW\r\n-----END CERTIFICATE REQUEST-----","fp":"6ec9561ddbab162144b8235a4a3b8cc25778b3e7bf0e31f748180c4212ca9156"},{"key":"-----BEGIN RSA PRIVATE KEY-----\r\nMIICXgIBAAKBgQD3+fOWjDTQM0kQGiXKGiCxhciRzHYxEmnGu8VSssq701TVo3e0\r\nVVjbD/qYGcQCFny04E9nGxSHSVxxte3zqYl+oly0vD2geRm+pTPMHXiH+QcOMvRv\r\nvalXp9R9Lj6fseCumVOPvL+FcEspbzwVArpz8GjKYm9R35/0haTY0wdEBQIDAQAB\r\nAoGBAMpDxrx1gF6SdnX73fcLeL9UMFU8QOul6UGAx2K9E0BBEGFyBKHDO8bzMaP+\r\n4DITxYSDskCXhhcTb6QQkRa+orZdDz4oLNqYEUZIuuBNfPaLSJOS8zcFTRxZIVJ/\r\n1SabLCSuyLVoP0GimJdM0higZCvToqRGhANBjgMhnBVVS0HBAkEA/aqkj8+Pll76\r\nPAyC1DxchcbQtw18ka0jTwZuXGbr9fqoS6WdTWwhnGd8+YZUnvFKq3cqzkE1LOdQ\r\nGboCRBpUGwJBAPpB6K1CJbQpfxhPUTcC/TTiJtMk5AlBPA5WeBhgXjhmI+eNcD8b\r\naENT9OuDJ1w3ImmTzEiDRVvS5tstxid7Cl8CQQCejQFMzhxejcD0tZE0nQHrr+gW\r\n8nwRBdoS898ZLE+CMQjuN3cJxHOBsgGgaUENE55rbBG6V3GoPnCHlAcEkDxPAkBI\r\nHB2zbs/2bc6VbqV0OIRFbLTLOmIK2KU5bGkGfR4pGiVWX0bsqDUO0W5NPmllBO4B\r\nhfjjHBAsOUUT+siSL735AkEAokyoZ9zpnQk7A869PoaUiaJIkek5V3FIgMudVpq2\r\niw185ccr2DNYsoHN0AM5FM0JP/QIxZgEHcua40z4wMuOeg==\r\n-----END RSA PRIVATE KEY-----","csr":"-----BEGIN CERTIFICATE REQUEST-----\r\nMIIBmjCCAQMCAQAwWjELMAkGA1UEBhMCQVIxFzAVBgNVBAoTDlRhbGxlciBTNEEg\r\nVW5vMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMRcwFQYDVQQDEw5UYWxsZXIg\r\nUzRBIFVubzCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEA9/nzlow00DNJEBol\r\nyhogsYXIkcx2MRJpxrvFUrLKu9NU1aN3tFVY2w/6mBnEAhZ8tOBPZxsUh0lccbXt\r\n86mJfqJctLw9oHkZvqUzzB14h/kHDjL0b72pV6fUfS4+n7HgrplTj7y/hXBLKW88\r\nFQK6c/BoymJvUd+f9IWk2NMHRAUCAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4GBANni\r\nWgcDaukw6w5XJMVSNfApcejhHPeEDz/owDo7xGlaah7xvvvlIhywNchn8I4aVz+F\r\na+n/rmjEDYqjlYUJ01Alp1cFhsvW26jq9kKYsflADbB64uBnpKXdu+LpFPMSQapc\r\nlyQ8JbB/sVdltR9cWDvDD4KBs2kpHWuVKcg/LIBz\r\n-----END CERTIFICATE REQUEST-----","fp":"a072f8f0bd0b9028e89ea6b9b8fa2fb38b02367e4e3c72f2c35e7aa5d2cb9323"},{"key":"-----BEGIN RSA PRIVATE KEY-----\r\nMIICXAIBAAKBgQDo//jUtHdn5aQTXZDq+je8PMCNiHAyy8y3NUuaE0SN2jcJj8oY\r\nzg2GxgwPVX+fu2L+25d87P7DEPyTEiVRHsD3HSS3aBkRUjWD0iOD78/+UmdtuNvH\r\nMqytkUyYy+G8ks7ONEsNa2WwTweroNv738ISyy/LZOnavW7HE2ilgtv5aQIDAQAB\r\nAoGAeZQfrjXg3JjqTaSUGtinvpRg0Tlxej/3uV2Y7nPBYNeNwnKCPQE/86Rh5Jpz\r\ndtDbriq9WFV99iFl+gQM7tBCVXCZpvyxNW6a+sfCohbrHAJ9SCV+benfMXZoT6OA\r\n+rSaMDKhbuhVywNFlj91S1IB+Pi0Z7IB5Io0vlwvvQV8FtUCQQDr3O9F2AwoRNCe\r\nELflQ5/Zmngw6c30ytfh6VWYVsAMIfn9P6P/ckWg9LuCFKBIVWl4dc7UfBcg0kpB\r\nFsj0pYLrAkEA/OR1ytShAIY+5RH3mxZUaeTMIKBIbUDFJsTutx7PxxX09dYjG2kr\r\nYpKjbOn3ppEHW5CQNzaYbJBTdjQO3hSX+wJAWAMGShK3XqNnEUR9ypA0ateoN+BW\r\n2RyD+CnAperhGOXoyeZghOaYMtp/yad2s+cjRy72sfVoD/hIewdMj3XfZwJBANtX\r\nI7talJIp3Z886C9BPNHjuhCKNIdd6CFqKUn2lWwtZRtcMXLy0shaOxiaDUwQ+fq2\r\n9f6NgcKXo2wgVszTu8UCQGFhp4i9F/vkyZ42paEHOMHfHRWcZxOcAciJejYXyXcD\r\ntaJwmy6mZDAmtOoEv71QtHVB/exiGnpYVT390ES4hpU=\r\n-----END RSA PRIVATE KEY-----","csr":"-----BEGIN CERTIFICATE REQUEST-----\r\nMIIBmjCCAQMCAQAwWjELMAkGA1UEBhMCQVIxFzAVBgNVBAoTDlRhbGxlciBTNEEg\r\nVW5vMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMRcwFQYDVQQDEw5UYWxsZXIg\r\nUzRBIFVubzCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEA6P/41LR3Z+WkE12Q\r\n6vo3vDzAjYhwMsvMtzVLmhNEjdo3CY/KGM4NhsYMD1V/n7ti/tuXfOz+wxD8kxIl\r\nUR7A9x0kt2gZEVI1g9Ijg+/P/lJnbbjbxzKsrZFMmMvhvJLOzjRLDWtlsE8Hq6Db\r\n+9/CEssvy2Tp2r1uxxNopYLb+WkCAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4GBAMS8\r\nSV/lMtz+0S7etN6euQuRDeKtrumzTgbBkc+l8E5ldN62BnS+sm+f+WT5BwoW51Mg\r\nA5v1bINjfnhHnBOMA7jIeLziqkw2IuK0hLU5GjJJJG2OtaFqt9dwk8HhO5kx7mw5\r\nyrKqS6Q/VG87ywkAKiHdGkepVEU/DBm4Wo3+xdAh\r\n-----END CERTIFICATE REQUEST-----","fp":"2ba272036f146bed30eda6c8850549e78c728712479a1df14728955ea8749e30"},{"key":"-----BEGIN RSA PRIVATE KEY-----\r\nMIICXAIBAAKBgQCXMctSuCsKW2FOtx1urQAPJnE/Uov86eYR7Haha6/7OwClWhZR\r\nsb9lgPNk4s20PStmAKvVFOhpTNpVGndZoNut3pe2xvfksFWm4SSGgWGsab638IYP\r\nbmRshpTexIEE0QlEkztA+vzImcOua2ykWklG8lBmwm9lRzf3adzROxTRbwIDAQAB\r\nAoGAa34pcjwhzZE+U3p44HD688p/BWgowr2ApwmZJhar3VALm4O7DoXy77WIVhex\r\n7Az5R+H+SNY+jm7nY04XwI9O3uz84L4Thi4pO9vuTI35mVM0p/1LRQGOBSQsMMnS\r\nm6fq4oo0pG6qmeNi/0XLJd43NMzgGBmd4bhOos8iQETBPeECQQDEXH/AE3/TiJTC\r\nByTCTJPi+LLnDXN+osUt3qwa8WsSW4Ro/cUbA5gbz8rmr1fmqG+mqe7FGCfi2pi2\r\ndhdc4H1pAkEAxR17P+CUXiDeiPHMcZGDC4ESLffYAaERoGpkx+/DnojFjev01y1I\r\ndURSPBS23kFSskRvQVwk89cSpn6yAXKFFwJAUUlhcSghUHZH7pJ6exysU9dUaCW/\r\nW/sR2U1GvdiW1ICiLbxv7iDsxQaeHiUUJF4x6jKKr3iyeky3z0DPpxkfkQJBALY6\r\n5zLKwN+0q4cXY9aqm+gKz2/H7d6ztcQEGF/u/X6XG2x1c8lqh85B93SsAdO/uGAu\r\nfFyEf3UepJNgFdjYsskCQH6r1sONsmW8ljnz6FfkZC76OqBcSjHCpzC/gCddcXfU\r\n/WBzWFL0lcWaWdvMzfsFER4eqeIGY/JovkOX8E0gwuc=\r\n-----END RSA PRIVATE KEY-----","csr":"-----BEGIN CERTIFICATE REQUEST-----\r\nMIIBmjCCAQMCAQAwWjELMAkGA1UEBhMCQVIxFzAVBgNVBAoTDlRhbGxlciBTNEEg\r\nVW5vMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMRcwFQYDVQQDEw5UYWxsZXIg\r\nUzRBIFVubzCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAlzHLUrgrClthTrcd\r\nbq0ADyZxP1KL/OnmEex2oWuv+zsApVoWUbG/ZYDzZOLNtD0rZgCr1RToaUzaVRp3\r\nWaDbrd6Xtsb35LBVpuEkhoFhrGm+t/CGD25kbIaU3sSBBNEJRJM7QPr8yJnDrmts\r\npFpJRvJQZsJvZUc392nc0TsU0W8CAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4GBACLz\r\n9j8sdGPXivz0ss8/+sXkWLcrOqOnyAOGdKCxmYysg+rDKfrHqC7o40QXyVg3mMZ4\r\nlDyQETij0WTWmjoIZANP3xdCjDirsXPDRarJby9fN7szZibc2e83VEu0Vf0Hqt9C\r\nQfDNjqjSQyz/2o3xIwE/rFbi1TSCrkSWIXypNUgT\r\n-----END CERTIFICATE REQUEST-----","fp":"8c1b270f5ca289ad8601d6a38ffc1efe6bff84640cfa7cc6306d0984b6fa38ad"}]

async function psql(sql) {
  const { stdout } = await exec('docker', ['exec', '-i', CONTAINER, 'psql', '-X', '-t', '-A', '-U', 'postgres', '-d', 'postgres', '-c', sql], { maxBuffer: 10 * 1024 * 1024 })
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
  const secrets = Number(await psql(`SELECT count(*) FROM vault.secrets WHERE name LIKE 'arca-private-key-rotation:%';`))
  const orphans = Number(await psql(`SELECT (SELECT count(*) FROM vault.secrets WHERE name LIKE 'arca-private-key-rotation:%') - (SELECT count(*) FROM private.arca_credential_rotations WHERE state='pending_rotation');`))
  return { pending, secrets, orphans }
}

let fail = 0
const check = (c, l) => { c ? console.log('PASS: ' + l) : (fail++, console.log('FAIL: ' + l)) }

async function main() {
  console.log('AFIP-S4A/S4A.1 — carrera de preparación de rotación\n')
  await psql(`
    INSERT INTO auth.users (id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
    VALUES ('${USR}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','s4a-race@test.local','',now(),now())
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.businesses (id,name,owner_user_id,subscription_plan,subscription_status)
    VALUES ('${BIZ}','S4A-race','${USR}','pro','active') ON CONFLICT (id) DO UPDATE SET owner_user_id=EXCLUDED.owner_user_id;`)

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
    DELETE FROM public.businesses WHERE id='${BIZ}';
    DELETE FROM auth.users WHERE id='${USR}';`)
  console.log(fail === 0 ? '\n✅ concurrencia S4A/S4A.1 OK' : `\n❌ concurrencia: ${fail} fallo(s)`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch(e => { console.error('harness error:', e.message); process.exit(1) })
