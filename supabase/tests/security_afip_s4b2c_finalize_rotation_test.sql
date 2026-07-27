-- ============================================================================
-- AFIP-S4B-2C — finalización auditada de una rotación activada y verificada.
--
-- Fixtures SINTÉTICOS (RSA 2048 + certificados autofirmados) generados con
-- scripts/finance/gen-s4b2c-fixtures.mjs. NUNCA se usa el certificado
-- productivo emitido por ARCA. Todo dentro de BEGIN…ROLLBACK.
--
-- RUN: docker exec <db> psql -X -U postgres -d postgres -f este.sql
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL request.jwt.claims = '{"role":"service_role"}';

\set BIZ '00000000-0000-4000-8000-0000000054c1'
\set OWNER '00000000-0000-4000-8000-0000000054c2'
\set FP_OLD '21a64c517e8071808e46897428e1540026c5a781c8af0727fcab227bd44de2ad'
\set FP_NEW 'fda3f718f6bfd96a576c5a551843112c2826e0129a43a1c960c2bce9ba9b9dc0'

INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
VALUES (:'OWNER', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        's4b2c-owner@test.local', '', now(), now()) ON CONFLICT (id) DO NOTHING;
INSERT INTO public.businesses (id, name, owner_user_id, subscription_plan, subscription_status)
VALUES (:'BIZ', 'S4B2C-test', :'OWNER', 'pro', 'active')
ON CONFLICT (id) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id;

CREATE TEMP TABLE fx (name text primary key, pem text);
INSERT INTO fx VALUES ('key_old', $p$-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAq45KCGErqCekYWFHtRHyexd2uvwsxejO6Pwpm1XvW4EaLhh5
1WrlX57uzpnAgQAfo86Rf5oVKuBdhGI4KQBwKH1vFR3K0gezPF8UzDyIudhKq1jt
0MtUAPiTp5rWK6IWYv4x2vwTY9AWYzW5ec0utXVfuo8mFZJxsdOsN9YhbNfxe6VT
pcqf7YC9gxn6ULPE+LyUXdR1u5QOvaYrkBdRqVH0Sk0NI6jZ5vKMMKRmC4RLHB5P
bkSGrvGz0tg7wzks7EXGJxuyE6fII5k8YYij6bVBFZpnoegnAzeosmKlIp+lFHtu
E6QsAnm5ZyIp4BQOYxkSAyCdX1lEI8WsJo5bCQIDAQABAoIBAHvMcXY8kOGGweOX
7MQo0F+tXfuvUKv8xZtxpKC40cKplnffJ8QvoJhxO4mRgE5XBX4S6gI38cCAKlwG
+Nn1u/osEkYduqf38IrHXl3H7S6Xe8LMqMj8gYE14G+Zl6XjEN6c6uNI9sEXf6BW
O6M+ws8lhVA+TtBQXoVh56xfdL1ypRIpW/By9P2OdroLxswW/dvVxTEgOZRSAqiL
8N8JQUKLJNbpT/jQGXV2W42GezLnT5oLQ85FDCy9YJYIY8nSthP1s94XVcv65AXV
i5ZVukvv3lR+1ra+ZUq8qqx+x9BnOCQ9NmCxoP6Fz5Fk9OaoyYK9Bs+hFuhjcykj
umeaJkUCgYEA04Ggi8pWdwTws7KVByM64WmnnGWorCeuee1fnegymp7f6zjSSJ3f
QGieB9fddpS81E86x+FZxkqXEwh7cwwi/mteF+CSq1gGC1t/f9ik2PCmYpgtc/l3
bs1qvup0SEjXdhhGmfJAQ60FJYCMhlIOd4rh4dFExyKxATWaBHZ3/M8CgYEAz6Uu
zT/rtzs5G8GODjdzG6fKBOsD2fcsssAOCIWL/kiBCG9FWMZgM0qzixCl2Mq/zqhp
LyshfGvb4+kFrC6ItNSaXIt4MpwJlOTuzv/UUEFQ8INzDRoEQJ5extxFXBpLb8Fi
13yueWRrC3rGbj5cBiwWjMgasMEaJ5zjeWuskKcCgYEAjlK3+dkZ/dTxM7qD1d27
DVvPUcqGifHZ0moM4XESPEGUY/BEcGDrjafYT2bOu7CysBrwbvgRNQGUT1Zx26Tb
F2CgXGjdyTbeOl5DmX/qzaCCFe5ZB6Vi3MiVgAq8XLfHZMxJFeaRn/iZcfbimLA2
0/I8tXvgUC/j8/Bhx4cAjrkCgYAKTbQI00crDHFFA1G9OtsnYCgSHmdOhYleRVFs
8tODhq2AcaULRqy3XtmR6P2RyF3EL28ovAcpWWDL6mAxrw1xi6stNG5+dGe1T7bZ
5q/uW49cn+kxmTzkx/cD/yIh89wSa5IwByvRMj5tj2YRSl7en4lu6u8IHkzh8lMH
T2R8uQKBgQDCvG4F16rlR3QbOQ8Fhxe9srTpdA/z9Jz4uegzlnHzxH+shca0ORDm
BrYr+K5k3Gpo5oSDRwDE9LObUBeYLTWNux411o7wUTlTE3OrSsw9Bkn4egz4RtXn
osla9bm84PeQoUXZqbu4H0i/d/ZZi6upMPTeyV60vCybCX0bWZq+Vw==
-----END RSA PRIVATE KEY-----$p$);
INSERT INTO fx VALUES ('cert_old', $p$-----BEGIN CERTIFICATE-----
MIIC3zCCAcegAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBAKuOSghhK6gnpGFhR7UR8nsXdrr8LMXozuj8KZtV71uBGi4YedVq
5V+e7s6ZwIEAH6POkX+aFSrgXYRiOCkAcCh9bxUdytIHszxfFMw8iLnYSqtY7dDL
VAD4k6ea1iuiFmL+Mdr8E2PQFmM1uXnNLrV1X7qPJhWScbHTrDfWIWzX8XulU6XK
n+2AvYMZ+lCzxPi8lF3UdbuUDr2mK5AXUalR9EpNDSOo2ebyjDCkZguESxweT25E
hq7xs9LYO8M5LOxFxicbshOnyCOZPGGIo+m1QRWaZ6HoJwM3qLJipSKfpRR7bhOk
LAJ5uWciKeAUDmMZEgMgnV9ZRCPFrCaOWwkCAwEAATANBgkqhkiG9w0BAQsFAAOC
AQEAPPI8YZ2T7HPHKAFi9Scc9AqW4lPzxcAcbFewAz/FufV2bFeevaxgjpFAfpwH
YHCh8Pby0VLky6Tj1igRqDaIXIPMRnQ7rtr0PmBd9Zzik+ACvnGRtvBaORFHWFqS
EeLNEwNmcgarNnYnwi1eQq4M5HVGSKxeZS8Msg0heb7BUmZVehP3a3fB39ffdL2w
ZL0uWwG18A72nymfZEDIFcI2j16WGKMDTEd61C1McyiDhWCkRqRf21DLnQP1FpxW
MP9xh2UoBbxhQgRoRg8kHQ1jDWUpYTmtsr0jFWrMZMCTumIZ7/FfZq2Qe181YNMD
sSiIyIkmE4mF9i3ifJ9de51fPQ==
-----END CERTIFICATE-----$p$);
INSERT INTO fx VALUES ('key_new', $p$-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAsgFPjNCFCCbNTaJZ/aiNje5TdR6kyFChSZMf2sxp8OSBxLt/
3s3dNkx8NoMJTsdVKJeWpyOaM+ZekAG8nLU++nqFNtRKSRclgS7kZngjnAkwbfSt
0/vxNfx+Qb9u4dpaxerE1yV2DWMf1HT89s30shkbZLGE0Q11jD2Gz0u4O8zHfKnx
bFEX1uu34eyZPJvVLBPBA3e5eOE5KgDxincrd5LWYqh1SIXdLAlU/XnY0CQ8DEv3
JphshFTUUwY8FhN2zVc75khAzFgRt/a4GlktBQC8vXM6qpSTyzyC5cAdXq6HL/Hi
oaWVcRRnviUntaX8y61tT40AShiHTyDIqs/uPwIDAQABAoIBACQYIfJSwfbyL0Uj
u4205Oc3wVKJYS6BMwNBQv9R3dWL8EhdIMOkCMwe3D0NexCvWLQ/cLv5eyY0+03G
HGHGWrvdpi+FAn8po2A7ivLAP7A/KMPTDoBioPmqdkuMrsY7SZbCUSGzJen3BJhH
FJhTEOAgOS7E1EKzsPc77p8QIo51VAUA4vLhSwWV3d0z/halA/U8vu3aDG9QD9vL
63b3PwlC8Syy/Z+4S+t7EAFGRJ2KHNS8RsTo2W1ReIThptysrFrVhzPqVdscXpXE
KJF5k9d7MQ9lR5mMp+WaLxRoRhbpfdhFxSsXjqTmyIJqbyEwWidnoe86BFO/qgC/
VVuMfSECgYEAzOgDcbclM9LXPNqhRcOn3W7blcCcEA4gzuA1tbgpp6QubFHyZ5EP
MuD813iJPblhkkZsiRi8BbH8X0Tz4HspPGpOEWiVXCo4LAPT/65DQsaRiyo8IWB0
KWjvTc8wfDdYk/2ZAdTRZuuousUAqO8ncHvhVGCBIsazA3WzeRuFPnECgYEA3mQW
Z5f2ZXQVVrvSCLJH47z5hOKicSi0cuvY7OYcn2veHb99n3lblj5ap4wGFl0Am/aq
ovz5RaBgZazrd/mMhvOiUIJ8NPSvnOvkB1qmGbCrZxRMDuPoGR+M0sqidc5TGoTm
rB2WytIkHv5Jgp2919nKLwhIf3OPyP/VQfE7r68CgYBfVrCLj3h61WYaRWt2R2Pq
jrMSyWyTt88iEoZLB+Yxvx1ufu53q7HTrYVXSBkrI/83DRdg7qZFTBwtw6ppT0TP
fHLYfL3KBUbfi+Ru+YkIH9YGV19k9Dj4L3/wxy87DJFlQkCX7oqEBbAbPqBg+e1y
0+Dy3ngXUzZlrLUV620isQKBgA2z0QWVAWOC4YW0kN5kTbWkgSNE64lZXrTt/zGp
g/32oXrnv4/B5Hi/YsqMABwEovL5Ic5lE97MYOQi4WdFAvmVrVyUjZ6drOxYRHaH
iVBv6D+zqnQIataRcRXT0mq7ybcKlUPpls7sX7lhJZpcqcPQ8XowYncn4aYazUMA
4BKVAoGBALsrbIA1sUKOGgs4qQ7k2nRhLNksQakWZ+UwkGUpAcEBz06eyDgLmRcA
uPjQOYUb6vs4gh6E3wkv8eGJ/E+Dwyw2leWpkKp0GKuhSRPXQl6RIbhK14imb73k
0LwRPNDf/hcevHt5UsPh8WcnowfZ+XIyjlger3PmJaJmGxnQHO8c
-----END RSA PRIVATE KEY-----$p$);
INSERT INTO fx VALUES ('csr_new', $p$-----BEGIN CERTIFICATE REQUEST-----
MIICeDCCAWACAQAwMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZMBcGA1UEBRMQ
Q1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
ALIBT4zQhQgmzU2iWf2ojY3uU3UepMhQoUmTH9rMafDkgcS7f97N3TZMfDaDCU7H
VSiXlqcjmjPmXpABvJy1Pvp6hTbUSkkXJYEu5GZ4I5wJMG30rdP78TX8fkG/buHa
WsXqxNcldg1jH9R0/PbN9LIZG2SxhNENdYw9hs9LuDvMx3yp8WxRF9brt+HsmTyb
1SwTwQN3uXjhOSoA8Yp3K3eS1mKodUiF3SwJVP152NAkPAxL9yaYbIRU1FMGPBYT
ds1XO+ZIQMxYEbf2uBpZLQUAvL1zOqqUk8s8guXAHV6uhy/x4qGllXEUZ74lJ7Wl
/MutbU+NAEoYh08gyKrP7j8CAwEAAaAAMA0GCSqGSIb3DQEBCwUAA4IBAQAmVirZ
sZhdXpK1be9QcFpsYVMAeEkCmga2P/xmuWyV/fK8PlSlfXfAuPuq0coQQVUJMNhK
51nqLaPlx0z0w/tUDrRlEz1pPpXvk/4hW7J5gMjISBOM7He7um1/u1rHkMwEO4oU
1oi4tOZoF7Fx+3LzozPs3+1DkHutvWA/OY2DJpWv4bPlQRERJZxhWYH+OVjAO7if
S/7L1KKRHWb/PbsBokscbzlQi+SPH1Xfzmyccr7ancEsDDw8yD4/vWSudAO2ndXs
ahaRKTy0PJGbHi2a2TPQ610ELt9k+eKpcozbPx2y1IsXnEB/e+UV6buRSScyrYk7
s9dCZekH1wjeKnmq
-----END CERTIFICATE REQUEST-----$p$);
INSERT INTO fx VALUES ('cert_new', $p$-----BEGIN CERTIFICATE-----
MIIC3zCCAcegAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTM1MDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBALIBT4zQhQgmzU2iWf2ojY3uU3UepMhQoUmTH9rMafDkgcS7f97N
3TZMfDaDCU7HVSiXlqcjmjPmXpABvJy1Pvp6hTbUSkkXJYEu5GZ4I5wJMG30rdP7
8TX8fkG/buHaWsXqxNcldg1jH9R0/PbN9LIZG2SxhNENdYw9hs9LuDvMx3yp8WxR
F9brt+HsmTyb1SwTwQN3uXjhOSoA8Yp3K3eS1mKodUiF3SwJVP152NAkPAxL9yaY
bIRU1FMGPBYTds1XO+ZIQMxYEbf2uBpZLQUAvL1zOqqUk8s8guXAHV6uhy/x4qGl
lXEUZ74lJ7Wl/MutbU+NAEoYh08gyKrP7j8CAwEAATANBgkqhkiG9w0BAQsFAAOC
AQEAFMQtjF1s2BYbBKlXfL/qtXh2TKLT3D6u9bzWDyZWpfIS25Pbi5GJzr8S2LxP
MhpYzcoHtKdOn9B1NFxRMvNOI8uBMXC/Nr0oiVvbnsVx4+VrEEG9ghaPzlYvUYhG
UIPSLzeV61/T2jfs0X6rrKk0lPDnPvRKb51mtumGCeL0ZQAwAQSa3g8H8cWzHGq3
VEJR7zoWeAX/59pPKP8Q33xbaiDkNfYrYl7NBeHG7xWr0HoHVotNT1RIglABZg2f
/1lxdVxzaBwn64zSavyi8H6FEdTrFzwtpl/O016uiDW79HVPDwIIxNWHZIjS5HZI
c2GUUOQ7kyv4kiP5Hz/+MYw5xQ==
-----END CERTIFICATE-----$p$);
INSERT INTO fx VALUES ('cert_new_badcn', $p$-----BEGIN CERTIFICATE-----
MIIC2TCCAcGgAwIBAgIBATANBgkqhkiG9w0BAQsFADAwMRMwEQYDVQQDEwpvdHJv
LmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAzMDAw
MFoXDTM1MDEwMTAzMDAwMFowMDETMBEGA1UEAxMKb3Ryby5hbGlhczEZMBcGA1UE
BRMQQ1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC
ggEBALIBT4zQhQgmzU2iWf2ojY3uU3UepMhQoUmTH9rMafDkgcS7f97N3TZMfDaD
CU7HVSiXlqcjmjPmXpABvJy1Pvp6hTbUSkkXJYEu5GZ4I5wJMG30rdP78TX8fkG/
buHaWsXqxNcldg1jH9R0/PbN9LIZG2SxhNENdYw9hs9LuDvMx3yp8WxRF9brt+Hs
mTyb1SwTwQN3uXjhOSoA8Yp3K3eS1mKodUiF3SwJVP152NAkPAxL9yaYbIRU1FMG
PBYTds1XO+ZIQMxYEbf2uBpZLQUAvL1zOqqUk8s8guXAHV6uhy/x4qGllXEUZ74l
J7Wl/MutbU+NAEoYh08gyKrP7j8CAwEAATANBgkqhkiG9w0BAQsFAAOCAQEAh874
KqhP9SxcBld336yBw/d2RDPrVL1r3/FeBNdsxUqzqPajPjw3+nV508wOFKXRl0Ow
sKSZhmSDL+pbjCpGwVVI3N4veFkfyQcL1ePiB4e2XXvlgEt6u3wPgX5BppK+G1Ay
c9G8H92mBvlu6sHnK8La0K94bZ458yv0alJdBf/Si0uMGJgdzzGMptL+Wbte71ih
leBbhgpxrxy+I8yCI83MZKN/aGhi+fdTj8RVCqIsMa/Ye/2mpifBJcrbK4TuLwIe
u+nNKFHn8iKXsHXhN+kKgZL26tWEotoIxE6jc//2YneOq2diG48Q7a3RCM23EF3C
8XFvpUhz3MdH1xD3SA==
-----END CERTIFICATE-----$p$);
INSERT INTO fx VALUES ('cert_new_expired', $p$-----BEGIN CERTIFICATE-----
MIIC3zCCAcegAwIBAgIBATANBgkqhkiG9w0BAQsFADAzMRYwFAYDVQQDEw1maXh0
dXJlLmFsaWFzMRkwFwYDVQQFExBDVUlUIDIwMTExMTExMTEyMB4XDTIwMDEwMTAz
MDAwMFoXDTIxMDEwMTAzMDAwMFowMzEWMBQGA1UEAxMNZml4dHVyZS5hbGlhczEZ
MBcGA1UEBRMQQ1VJVCAyMDExMTExMTExMjCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBALIBT4zQhQgmzU2iWf2ojY3uU3UepMhQoUmTH9rMafDkgcS7f97N
3TZMfDaDCU7HVSiXlqcjmjPmXpABvJy1Pvp6hTbUSkkXJYEu5GZ4I5wJMG30rdP7
8TX8fkG/buHaWsXqxNcldg1jH9R0/PbN9LIZG2SxhNENdYw9hs9LuDvMx3yp8WxR
F9brt+HsmTyb1SwTwQN3uXjhOSoA8Yp3K3eS1mKodUiF3SwJVP152NAkPAxL9yaY
bIRU1FMGPBYTds1XO+ZIQMxYEbf2uBpZLQUAvL1zOqqUk8s8guXAHV6uhy/x4qGl
lXEUZ74lJ7Wl/MutbU+NAEoYh08gyKrP7j8CAwEAATANBgkqhkiG9w0BAQsFAAOC
AQEAoBHE8el0lqigQuDrB9bGdFXj43ClY21nQjru6k1H8vwyz44+LFrE/OqGm10o
n++ZKbmkJR3VuZDLAAxABzvGNc/nBeAUXf5LkoIXmDQllCjc7ETAkv85D2GxWGdF
qxR2S+szhRz2XyZcthlgXo3zg1cXu43odf7YHb8GOs6K+aaBXUctvWNRiRBsfRNZ
fR0fCh3dID1Cfd80C+CPSilEJX/jiopqNO/N4mZHsLG4WvQX0wtlxJ3+Sur//7bW
tQ2XgLEBmGqOaQyAT7O+fm7jFD1tCaScIJI3sCNl7h9sa0JkghdEK7Vxgx2AwDgk
/tm77a9dmHublKAir/NkQdQTEA==
-----END CERTIFICATE-----$p$);

\echo '── setup: credencial vieja en Vault + config con cache WSAA ──'
SELECT private.arca_store_private_key_secret(:'BIZ', (SELECT pem FROM fx WHERE name='key_old'),
       :'FP_OLD', NULL, 'RSA', 2048, :'OWNER', false) AS setup_store;

INSERT INTO public.arca_config (business_id, cuit, alias, ambiente, punto_venta, web_service,
        cert_file, private_key, wsaa_token, wsaa_sign, wsaa_token_expires, estado_conexion, expires_at)
SELECT :'BIZ', '20111111112', 'fixture.alias', 'homologacion', 1, 'wsfe',
       (SELECT pem FROM fx WHERE name='cert_old'),
       '-----BEGIN RSA PRIVATE KEY-----' || chr(10) || 'DUMMYLEGACYKEY' || chr(10) || '-----END RSA PRIVATE KEY-----',
       'TOKEN_VIEJO', 'SIGN_VIEJO', now() + interval '6 hours', 'conectado',
       timestamptz '2030-01-01 00:00:00+00'
ON CONFLICT (business_id) DO NOTHING;

\echo '── setup: rotación preparada y activada (contratos reales S4A/S4B-2A) ──'
SELECT public.arca_prepare_certificate_rotation(:'BIZ',
       (SELECT pem FROM fx WHERE name='key_new'), (SELECT pem FROM fx WHERE name='csr_new'),
       :'FP_NEW', 'RSA', 2048, 65537, NULL, 'idem-prep-c1', :'OWNER')->>'state' AS setup_prepare;

SELECT public.arca_activate_certificate_rotation(:'BIZ', NULL,
       (SELECT pem FROM fx WHERE name='cert_new'), :'FP_NEW', 'idem-act-c1', :'OWNER')->>'state' AS setup_activate;

CREATE TEMP TABLE pre AS
SELECT (SELECT private_key_fingerprint FROM private.arca_private_key_credentials WHERE business_id=:'BIZ') AS active_fp,
       (SELECT private_key_secret_id   FROM private.arca_private_key_credentials WHERE business_id=:'BIZ') AS active_secret,
       (SELECT prev_secret_id   FROM private.arca_credential_rotations WHERE business_id=:'BIZ')           AS prev_secret,
       (SELECT prev_fingerprint FROM private.arca_credential_rotations WHERE business_id=:'BIZ')           AS prev_fp,
       (SELECT md5(cert_file)   FROM public.arca_config WHERE business_id=:'BIZ')                          AS cert_md5,
       (SELECT md5(private_key) FROM public.arca_config WHERE business_id=:'BIZ')                          AS legacy_md5,
       (SELECT expires_at       FROM public.arca_config WHERE business_id=:'BIZ')                          AS expires_at,
       (SELECT activated_at     FROM private.arca_credential_rotations WHERE business_id=:'BIZ')           AS activated_at;

-- El refresh WSAA de S4B-2B dejó el cache poblado y la conexión en verde.
UPDATE public.arca_config SET wsaa_token='TOKEN_NUEVO', wsaa_sign='SIGN_NUEVO',
       wsaa_token_expires = now() + interval '11 hours', estado_conexion='conectado', ultimo_error=NULL
 WHERE business_id=:'BIZ';

CREATE TEMP TABLE res (n serial, label text, ok boolean);
CREATE OR REPLACE FUNCTION pg_temp.chk(l text, ok boolean) RETURNS void
LANGUAGE plpgsql AS $f$ BEGIN INSERT INTO res(label, ok) VALUES (l, coalesce(ok,false)); END $f$;

-- Invariante: el par activo, el certificado, la legacy y los secretos no cambiaron.
CREATE OR REPLACE FUNCTION pg_temp.intacto() RETURNS boolean LANGUAGE sql AS $f$
  SELECT (SELECT active_fp FROM pre)     = (SELECT private_key_fingerprint FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-0000000054c1')
     AND (SELECT active_secret FROM pre) = (SELECT private_key_secret_id   FROM private.arca_private_key_credentials WHERE business_id='00000000-0000-4000-8000-0000000054c1')
     AND (SELECT prev_secret FROM pre)   = (SELECT prev_secret_id FROM private.arca_credential_rotations WHERE business_id='00000000-0000-4000-8000-0000000054c1')
     AND (SELECT cert_md5 FROM pre)      = (SELECT md5(cert_file)   FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000054c1')
     AND (SELECT legacy_md5 FROM pre)    = (SELECT md5(private_key) FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000054c1');
$f$;
-- Invariante: la rotación no avanzó ni se corrigió el vencimiento.
CREATE OR REPLACE FUNCTION pg_temp.sin_finalizar() RETURNS boolean LANGUAGE sql AS $f$
  SELECT (SELECT state FROM private.arca_credential_rotations WHERE business_id='00000000-0000-4000-8000-0000000054c1') = 'activated_pending_verification'
     AND (SELECT expires_at FROM public.arca_config WHERE business_id='00000000-0000-4000-8000-0000000054c1') = (SELECT expires_at FROM pre);
$f$;
-- Evidencia WSAA con timestamp y fingerprint controlados (dentro de una misma
-- transacción now() es constante: el offset es lo que hace verificable el orden).
CREATE OR REPLACE FUNCTION pg_temp.evidencia(p_event text, p_status text, p_fp text, p_offset interval)
RETURNS void LANGUAGE sql AS $f$
  INSERT INTO private.arca_credential_audit (event, business_id, actor_user_id, environment, fingerprint_trunc, status, error_code, created_at)
  SELECT p_event, '00000000-0000-4000-8000-0000000054c1', NULL, NULL, p_fp, p_status, NULL,
         (SELECT activated_at FROM pre) + p_offset;
$f$;
CREATE OR REPLACE FUNCTION pg_temp.limpiar_evidencia() RETURNS void LANGUAGE sql AS $f$
  DELETE FROM private.arca_credential_audit
   WHERE business_id='00000000-0000-4000-8000-0000000054c1' AND event LIKE 'wsaa%';
$f$;

DO $t$
DECLARE r jsonb; v_rot uuid; v_notafter timestamptz;
        k_biz uuid := '00000000-0000-4000-8000-0000000054c1';
        k_own uuid := '00000000-0000-4000-8000-0000000054c2';
        k_new text; k_old text;
BEGIN
  SELECT id, private_key_fingerprint, prev_fingerprint INTO v_rot, k_new, k_old
    FROM private.arca_credential_rotations WHERE business_id = k_biz;
  v_notafter := (private.arca_cert_validity(private.arca_pem_to_der((SELECT pem FROM fx WHERE name='cert_new')))).not_after;

  -- ══ FASE A — negativos; la rotación sigue en activated_pending_verification ══

  -- 12: sin evidencia WSAA
  PERFORM pg_temp.limpiar_evidencia();
  r := public.arca_finalize_certificate_rotation(k_biz, NULL, k_new, 'idem-f-noev', k_own);
  PERFORM pg_temp.chk('12 sin evento WSAA → WSAA_VERIFICATION_NOT_FOUND', r->>'state'='WSAA_VERIFICATION_NOT_FOUND');
  PERFORM pg_temp.chk('12 nada se finalizó', pg_temp.sin_finalizar() AND pg_temp.intacto());

  -- 13: evidencia ANTERIOR a la activación
  PERFORM pg_temp.evidencia('wsaa_private_key_resolved_vault', 'vault', '', interval '-1 minute');
  r := public.arca_finalize_certificate_rotation(k_biz, NULL, k_new, 'idem-f-old', k_own);
  PERFORM pg_temp.chk('13 evidencia previa a la activación → WSAA_VERIFICATION_NOT_FOUND', r->>'state'='WSAA_VERIFICATION_NOT_FOUND');

  -- 14: resolución LEGACY posterior a la activación
  PERFORM pg_temp.limpiar_evidencia();
  PERFORM pg_temp.evidencia('wsaa_private_key_resolved_vault', 'vault', '', interval '1 minute');
  PERFORM pg_temp.evidencia('wsaa_private_key_resolved_legacy', 'legacy', '', interval '2 minutes');
  r := public.arca_finalize_certificate_rotation(k_biz, NULL, k_new, 'idem-f-legacy', k_own);
  PERFORM pg_temp.chk('14 resolución legacy posterior → WSAA_VERIFICATION_STALE', r->>'state'='WSAA_VERIFICATION_STALE');

  -- 15: evidencia con OTRO fingerprint (rama de comparación literal)
  PERFORM pg_temp.limpiar_evidencia();
  PERFORM pg_temp.evidencia('wsaa_private_key_resolved_vault', 'vault', left(k_old,16), interval '1 minute');
  r := public.arca_finalize_certificate_rotation(k_biz, NULL, k_new, 'idem-f-fpmm', k_own);
  PERFORM pg_temp.chk('15 evidencia con otro fingerprint → WSAA_FINGERPRINT_MISMATCH', r->>'state'='WSAA_FINGERPRINT_MISMATCH');

  -- evidencia BUENA (fingerprint vacío, como la emite hoy el contrato productivo)
  PERFORM pg_temp.limpiar_evidencia();
  PERFORM pg_temp.evidencia('wsaa_private_key_resolved_vault', 'vault', '', interval '1 minute');

  -- 4: fingerprint esperado distinto del activo
  r := public.arca_finalize_certificate_rotation(k_biz, NULL, k_old, 'idem-f-badfp', k_own);
  PERFORM pg_temp.chk('4 fingerprint esperado distinto → ACTIVE_CREDENTIAL_MISMATCH', r->>'state'='ACTIVE_CREDENTIAL_MISMATCH');
  PERFORM pg_temp.chk('4 nada se finalizó', pg_temp.sin_finalizar() AND pg_temp.intacto());

  -- 5: cert_file de OTRA clave (el certificado viejo)
  UPDATE public.arca_config SET cert_file = (SELECT pem FROM fx WHERE name='cert_old') WHERE business_id = k_biz;
  r := public.arca_finalize_certificate_rotation(k_biz, NULL, k_new, 'idem-f-badcert', k_own);
  PERFORM pg_temp.chk('5 cert_file de otra clave → ACTIVE_CERTIFICATE_MISMATCH', r->>'state'='ACTIVE_CERTIFICATE_MISMATCH');

  -- 6: misma clave, subject distinto
  UPDATE public.arca_config SET cert_file = (SELECT pem FROM fx WHERE name='cert_new_badcn') WHERE business_id = k_biz;
  r := public.arca_finalize_certificate_rotation(k_biz, NULL, k_new, 'idem-f-badsubj', k_own);
  PERFORM pg_temp.chk('6 subject distinto → ACTIVE_CERTIFICATE_MISMATCH', r->>'state'='ACTIVE_CERTIFICATE_MISMATCH');

  -- 7: misma clave y subject, certificado EXPIRADO
  UPDATE public.arca_config SET cert_file = (SELECT pem FROM fx WHERE name='cert_new_expired') WHERE business_id = k_biz;
  r := public.arca_finalize_certificate_rotation(k_biz, NULL, k_new, 'idem-f-exp', k_own);
  PERFORM pg_temp.chk('7 certificado expirado → CERTIFICATE_EXPIRED', r->>'state'='CERTIFICATE_EXPIRED');

  UPDATE public.arca_config SET cert_file = (SELECT pem FROM fx WHERE name='cert_new') WHERE business_id = k_biz;
  PERFORM pg_temp.chk('5/6/7 nada se finalizó', pg_temp.sin_finalizar());

  -- 8: checkpoint anterior ausente
  UPDATE private.arca_credential_rotations SET prev_secret_id = NULL WHERE id = v_rot;
  r := public.arca_finalize_certificate_rotation(k_biz, NULL, k_new, 'idem-f-nockpt', k_own);
  PERFORM pg_temp.chk('8 checkpoint ausente → PREVIOUS_CHECKPOINT_MISSING', r->>'state'='PREVIOUS_CHECKPOINT_MISSING');
  UPDATE private.arca_credential_rotations SET prev_secret_id = (SELECT prev_secret FROM pre) WHERE id = v_rot;

  -- 9: el secreto anterior ya no existe (equivale a un cleanup ejecutado)
  UPDATE private.arca_credential_rotations SET prev_secret_id = gen_random_uuid() WHERE id = v_rot;
  r := public.arca_finalize_certificate_rotation(k_biz, NULL, k_new, 'idem-f-noprev', k_own);
  PERFORM pg_temp.chk('9 secreto anterior ausente → PREVIOUS_SECRET_MISSING', r->>'state'='PREVIOUS_SECRET_MISSING');
  UPDATE private.arca_credential_rotations SET prev_secret_id = (SELECT prev_secret FROM pre) WHERE id = v_rot;

  -- 10: el secreto activo no existe
  UPDATE private.arca_private_key_credentials SET private_key_secret_id = gen_random_uuid() WHERE business_id = k_biz;
  r := public.arca_finalize_certificate_rotation(k_biz, NULL, k_new, 'idem-f-noactive', k_own);
  PERFORM pg_temp.chk('10 secreto activo ausente → ACTIVE_SECRET_MISSING', r->>'state'='ACTIVE_SECRET_MISSING');
  UPDATE private.arca_private_key_credentials SET private_key_secret_id = (SELECT active_secret FROM pre) WHERE business_id = k_biz;

  -- 11: una referencia de la rotación apunta a un secreto inexistente
  UPDATE private.arca_credential_rotations SET private_key_secret_id = gen_random_uuid() WHERE id = v_rot;
  r := public.arca_finalize_certificate_rotation(k_biz, NULL, k_new, 'idem-f-orphan', k_own);
  PERFORM pg_temp.chk('11 secreto huérfano → ORPHAN_SECRET_DETECTED', r->>'state'='ORPHAN_SECRET_DETECTED');
  UPDATE private.arca_credential_rotations SET private_key_secret_id = (SELECT active_secret FROM pre) WHERE id = v_rot;

  -- 16/17/18: cache WSAA incompleto o vencido
  UPDATE public.arca_config SET wsaa_token = NULL WHERE business_id = k_biz;
  r := public.arca_finalize_certificate_rotation(k_biz, NULL, k_new, 'idem-f-notok', k_own);
  PERFORM pg_temp.chk('16 token nulo → ROTATION_NOT_VERIFIED', r->>'state'='ROTATION_NOT_VERIFIED');
  UPDATE public.arca_config SET wsaa_token='TOKEN_NUEVO', wsaa_sign = NULL WHERE business_id = k_biz;
  r := public.arca_finalize_certificate_rotation(k_biz, NULL, k_new, 'idem-f-nosign', k_own);
  PERFORM pg_temp.chk('17 sign nulo → ROTATION_NOT_VERIFIED', r->>'state'='ROTATION_NOT_VERIFIED');
  UPDATE public.arca_config SET wsaa_sign='SIGN_NUEVO', wsaa_token_expires = now() - interval '1 hour' WHERE business_id = k_biz;
  r := public.arca_finalize_certificate_rotation(k_biz, NULL, k_new, 'idem-f-expired', k_own);
  PERFORM pg_temp.chk('18 token vencido → ROTATION_NOT_VERIFIED', r->>'state'='ROTATION_NOT_VERIFIED');
  UPDATE public.arca_config SET wsaa_token_expires = now() + interval '11 hours' WHERE business_id = k_biz;

  PERFORM pg_temp.chk('4-18 tras todos los rechazos: par activo intacto', pg_temp.intacto());
  PERFORM pg_temp.chk('4-18 tras todos los rechazos: sin finalizar', pg_temp.sin_finalizar());

  -- 33: fallo intermedio → ni el estado ni expires_at quedan a medias
  EXECUTE $x$CREATE OR REPLACE FUNCTION pg_temp.boom() RETURNS trigger LANGUAGE plpgsql AS
             $b$ BEGIN RAISE EXCEPTION 'boom'; END $b$$x$;
  CREATE TRIGGER s4b2c_boom BEFORE UPDATE ON public.arca_config
    FOR EACH ROW WHEN (NEW.expires_at IS DISTINCT FROM OLD.expires_at) EXECUTE FUNCTION pg_temp.boom();
  r := public.arca_finalize_certificate_rotation(k_biz, NULL, k_new, 'idem-f-boom', k_own);
  PERFORM pg_temp.chk('33 fallo intermedio → error sanitizado', r->>'state'='ROTATION_NOT_VERIFIED');
  PERFORM pg_temp.chk('33 fallo intermedio no dejó estado ni vencimiento a medias', pg_temp.sin_finalizar());
  PERFORM pg_temp.chk('33 fallo intermedio no consumió la idempotency key',
    NOT EXISTS (SELECT 1 FROM private.arca_credential_rotations WHERE finalization_idempotency_key='idem-f-boom'));
  DROP TRIGGER s4b2c_boom ON public.arca_config;

  -- ══ FASE B — finalización correcta ══
  PERFORM pg_temp.chk('2 estado previo = activated_pending_verification',
    (SELECT state FROM private.arca_credential_rotations WHERE id=v_rot) = 'activated_pending_verification');
  PERFORM pg_temp.chk('3 credencial activa única, activa y con el fingerprint nuevo',
    (SELECT count(*) FROM private.arca_private_key_credentials WHERE business_id=k_biz) = 1
    AND (SELECT credential_status FROM private.arca_private_key_credentials WHERE business_id=k_biz) = 'active'
    AND (SELECT private_key_fingerprint FROM private.arca_private_key_credentials WHERE business_id=k_biz) = k_new);

  r := public.arca_finalize_certificate_rotation(k_biz, NULL, k_new, 'idem-f-ok', k_own);
  PERFORM pg_temp.chk('1 finalización correcta → ROTATION_COMPLETED', r->>'state'='ROTATION_COMPLETED');
  PERFORM pg_temp.chk('1 transición reportada',
    r->>'previous_state'='activated_pending_verification' AND r->>'current_state'='completed');
  PERFORM pg_temp.chk('1 respuesta sin certificado, clave ni secret_id',
    (r::text) !~ 'BEGIN CERTIFICATE|PRIVATE KEY|secret_id|TOKEN_|SIGN_');
  PERFORM pg_temp.chk('1 rollback sigue disponible', (r->>'rollback_available')::boolean);

  -- 19: expires_at pasa a ser el notAfter real del certificado activo
  PERFORM pg_temp.chk('19 expires_at = notAfter del certificado',
    (SELECT expires_at FROM public.arca_config WHERE business_id=k_biz) = v_notafter);
  PERFORM pg_temp.chk('19 expires_at cambió respecto del previo',
    (SELECT expires_at FROM public.arca_config WHERE business_id=k_biz) IS DISTINCT FROM (SELECT expires_at FROM pre));
  PERFORM pg_temp.chk('19 el vencimiento previo quedó en el checkpoint',
    (SELECT prev_expires_at FROM private.arca_credential_rotations WHERE id=v_rot) = (SELECT expires_at FROM pre));

  -- 20/21/22/23/24: la finalización no toca material
  PERFORM pg_temp.chk('20 cert_file idéntico',
    (SELECT md5(cert_file) FROM public.arca_config WHERE business_id=k_biz) = md5((SELECT pem FROM fx WHERE name='cert_new')));
  PERFORM pg_temp.chk('21 fingerprint activo idéntico',
    (SELECT private_key_fingerprint FROM private.arca_private_key_credentials WHERE business_id=k_biz) = (SELECT active_fp FROM pre));
  PERFORM pg_temp.chk('22 secretos idénticos',
    (SELECT private_key_secret_id FROM private.arca_private_key_credentials WHERE business_id=k_biz) = (SELECT active_secret FROM pre)
    AND (SELECT prev_secret_id FROM private.arca_credential_rotations WHERE id=v_rot) = (SELECT prev_secret FROM pre));
  PERFORM pg_temp.chk('22 ambos secretos siguen vivos en Vault',
    (SELECT count(*) FROM vault.secrets s WHERE s.id IN ((SELECT active_secret FROM pre),(SELECT prev_secret FROM pre))) = 2);
  PERFORM pg_temp.chk('23 checkpoint completo permanece',
    (SELECT prev_fingerprint IS NOT NULL AND prev_certificate_pem IS NOT NULL AND prev_status='rollback_candidate'
       FROM private.arca_credential_rotations WHERE id=v_rot));
  PERFORM pg_temp.chk('24 private_key legacy idéntica',
    (SELECT md5(private_key) FROM public.arca_config WHERE business_id=k_biz) = (SELECT legacy_md5 FROM pre));
  PERFORM pg_temp.chk('24 token y sign intactos',
    (SELECT wsaa_token='TOKEN_NUEVO' AND wsaa_sign='SIGN_NUEVO' AND estado_conexion='conectado'
       FROM public.arca_config WHERE business_id=k_biz));

  -- 34/35: readback y ausencia de huérfanos
  PERFORM pg_temp.chk('34 readback: completed + finalized_at + actor + evidencia',
    (SELECT state='completed' AND finalized_at IS NOT NULL AND finalized_by=k_own
       AND wsaa_verified_at IS NOT NULL AND certificate_not_after = v_notafter
       FROM private.arca_credential_rotations WHERE id=v_rot));
  PERFORM pg_temp.chk('34 la clave activa sigue correspondiendo al certificado activo',
    private.arca_key_matches_certificate(private.arca_get_private_key_for_signing(k_biz),
      (SELECT cert_file FROM public.arca_config WHERE business_id=k_biz)));
  PERFORM pg_temp.chk('35 cero referencias a secretos inexistentes',
    NOT EXISTS (SELECT 1 FROM (
        SELECT private_key_secret_id AS sid FROM private.arca_private_key_credentials WHERE business_id=k_biz
        UNION ALL SELECT private_key_secret_id FROM private.arca_credential_rotations WHERE business_id=k_biz
        UNION ALL SELECT prev_secret_id FROM private.arca_credential_rotations WHERE business_id=k_biz) q
      WHERE q.sid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vault.secrets s WHERE s.id=q.sid)));

  -- ══ FASE C — idempotencia ══
  r := public.arca_finalize_certificate_rotation(k_biz, NULL, k_new, 'idem-f-ok', k_own);
  PERFORM pg_temp.chk('25 replay misma key → ROTATION_ALREADY_COMPLETED', r->>'state'='ROTATION_ALREADY_COMPLETED');
  PERFORM pg_temp.chk('25 el replay no duplica el evento terminal',
    (SELECT count(*) FROM private.arca_credential_audit
      WHERE business_id=k_biz AND event='arca_certificate_rotation_completed') = 1);

  r := public.arca_finalize_certificate_rotation(k_biz, NULL, k_old, 'idem-f-ok', k_own);
  PERFORM pg_temp.chk('26 misma key + fingerprint distinto → IDEMPOTENCY_CONFLICT', r->>'state'='IDEMPOTENCY_CONFLICT');

  r := public.arca_finalize_certificate_rotation(k_biz, NULL, k_new, 'idem-f-otra', k_own);
  PERFORM pg_temp.chk('27 otra key sobre completed → ROTATION_ALREADY_COMPLETED', r->>'state'='ROTATION_ALREADY_COMPLETED');
  PERFORM pg_temp.chk('27 sigue habiendo una sola transición terminal',
    (SELECT count(*) FROM private.arca_credential_audit
      WHERE business_id=k_biz AND event='arca_certificate_rotation_completed') = 1);
  PERFORM pg_temp.chk('27 la key original no fue reemplazada',
    (SELECT finalization_idempotency_key FROM private.arca_credential_rotations WHERE id=v_rot) = 'idem-f-ok');

  -- ══ FASE D — rollback DESPUÉS de completed ══
  -- 32: con el secreto anterior purgado (simula S4C) el rollback se rechaza
  UPDATE private.arca_credential_rotations SET prev_secret_id = gen_random_uuid() WHERE id = v_rot;
  r := public.arca_rollback_certificate_rotation(k_biz, NULL, 'idem-rb-blocked', k_own);
  PERFORM pg_temp.chk('32 rollback tras cleanup → PREVIOUS_SECRET_MISSING', r->>'state'='PREVIOUS_SECRET_MISSING');
  PERFORM pg_temp.chk('32 el rechazo no revirtió nada',
    (SELECT state FROM private.arca_credential_rotations WHERE id=v_rot) = 'completed'
    AND (SELECT private_key_fingerprint FROM private.arca_private_key_credentials WHERE business_id=k_biz) = k_new);
  UPDATE private.arca_credential_rotations SET prev_secret_id = (SELECT prev_secret FROM pre) WHERE id = v_rot;

  -- 30: rollback desde completed restaura el par anterior
  r := public.arca_rollback_certificate_rotation(k_biz, NULL, 'idem-rb-1', k_own);
  PERFORM pg_temp.chk('30 rollback desde completed → ROTATION_ROLLED_BACK', r->>'state'='ROTATION_ROLLED_BACK');
  PERFORM pg_temp.chk('30 credencial restaurada a la clave anterior',
    (SELECT private_key_fingerprint FROM private.arca_private_key_credentials WHERE business_id=k_biz) = k_old
    AND (SELECT private_key_secret_id FROM private.arca_private_key_credentials WHERE business_id=k_biz) = (SELECT prev_secret FROM pre));
  PERFORM pg_temp.chk('30 certificado anterior restaurado',
    (SELECT md5(cert_file) FROM public.arca_config WHERE business_id=k_biz) = md5((SELECT pem FROM fx WHERE name='cert_old')));
  PERFORM pg_temp.chk('30 expires_at anterior restaurado',
    (SELECT expires_at FROM public.arca_config WHERE business_id=k_biz) = (SELECT expires_at FROM pre));
  PERFORM pg_temp.chk('30 cache WSAA invalidado',
    (SELECT wsaa_token IS NULL AND wsaa_sign IS NULL AND wsaa_token_expires IS NULL FROM public.arca_config WHERE business_id=k_biz));
  PERFORM pg_temp.chk('30 ningún secreto fue borrado',
    (SELECT count(*) FROM vault.secrets s WHERE s.id IN ((SELECT active_secret FROM pre),(SELECT prev_secret FROM pre))) = 2);
  PERFORM pg_temp.chk('30 la clave restaurada corresponde al certificado restaurado',
    private.arca_key_matches_certificate(private.arca_get_private_key_for_signing(k_biz),
      (SELECT cert_file FROM public.arca_config WHERE business_id=k_biz)));

  -- 31: replay del rollback
  r := public.arca_rollback_certificate_rotation(k_biz, NULL, 'idem-rb-2', k_own);
  PERFORM pg_temp.chk('31 replay de rollback → ROLLBACK_ALREADY_APPLIED', r->>'state'='ROLLBACK_ALREADY_APPLIED');
  PERFORM pg_temp.chk('31 sigue en rolled_back',
    (SELECT state FROM private.arca_credential_rotations WHERE id=v_rot) = 'rolled_back');

  -- 28: la auditoría no contiene material sensible
  PERFORM pg_temp.chk('28 auditoría sin PEM, clave, token ni CUIT',
    NOT EXISTS (SELECT 1 FROM private.arca_credential_audit a
      WHERE a.business_id = k_biz
        AND (coalesce(a.status,'') || coalesce(a.error_code,'') || coalesce(a.fingerprint_trunc,'')
             || coalesce(a.details::text,'')) ~ 'BEGIN CERTIFICATE|PRIVATE KEY|TOKEN_|SIGN_|20111111112'));
  PERFORM pg_temp.chk('28 details registra la transición y los timestamps',
    (SELECT details ? 'previous_state' AND details ? 'current_state' AND details ? 'wsaa_verified_at'
            AND details ? 'certificate_not_after' AND details ? 'activated_at' AND details ? 'idempotency_ref'
       FROM private.arca_credential_audit
      WHERE business_id=k_biz AND event='arca_certificate_rotation_completed' LIMIT 1));
  PERFORM pg_temp.chk('28 se auditó inicio, fallos y replay',
    (SELECT count(*) FROM private.arca_credential_audit WHERE business_id=k_biz
      AND event='arca_certificate_rotation_finalization_started') >= 1
    AND (SELECT count(*) FROM private.arca_credential_audit WHERE business_id=k_biz
      AND event='arca_certificate_rotation_finalization_failed') >= 10
    AND (SELECT count(*) FROM private.arca_credential_audit WHERE business_id=k_biz
      AND event='arca_certificate_rotation_finalization_replayed') = 1);
END $t$;

-- 29: grants — la finalización es service_role-only
SELECT pg_temp.chk('29 anon SIN execute',
  NOT has_function_privilege('anon', 'public.arca_finalize_certificate_rotation(uuid,uuid,text,text,uuid)', 'EXECUTE'));
SELECT pg_temp.chk('29 authenticated SIN execute',
  NOT has_function_privilege('authenticated', 'public.arca_finalize_certificate_rotation(uuid,uuid,text,text,uuid)', 'EXECUTE'));
SELECT pg_temp.chk('29 PUBLIC SIN execute',
  NOT has_function_privilege('public', 'public.arca_finalize_certificate_rotation(uuid,uuid,text,text,uuid)', 'EXECUTE'));
SELECT pg_temp.chk('29 service_role CON execute',
  has_function_privilege('service_role', 'public.arca_finalize_certificate_rotation(uuid,uuid,text,text,uuid)', 'EXECUTE'));
SELECT pg_temp.chk('29 SECURITY DEFINER con search_path fijo y owner postgres',
  (SELECT p.prosecdef AND array_to_string(p.proconfig,',') LIKE '%search_path%' AND pg_get_userbyid(p.proowner)='postgres'
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='arca_finalize_certificate_rotation'));

\echo ''
\echo '════════ RESULTADO AFIP-S4B-2C ════════'
SELECT n, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS r, label FROM res ORDER BY n;
SELECT count(*) FILTER (WHERE ok) AS pass, count(*) FILTER (WHERE NOT ok) AS fail, count(*) AS total FROM res;
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM res WHERE NOT ok) THEN
    RAISE EXCEPTION 'AFIP-S4B-2C: % asserts fallaron', (SELECT count(*) FROM res WHERE NOT ok);
  END IF;
END $g$;

ROLLBACK;
