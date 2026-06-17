# Product context

## TechRepair Pro

TechRepair Pro is a SaaS management platform for cellphone repair shops, electronics technicians and mobile-accessory retailers.

Its purpose is to unify daily commercial and technical operations in one reliable system.

Main areas include:

- Repair orders.
- Customers.
- Products and variants.
- Inventory and stock.
- Suppliers and purchases.
- POS and receipts.
- Daily cash register.
- Business finance.
- Customer accounts.
- ARCA invoicing.
- Credit notes.
- Warranties.
- WhatsApp communication.
- Reports.
- Users, roles and SaaS plans.
- Wholesale portal.
- Personal finance through Mi Guita.

## Technology

Primary stack:

- React 18.
- TypeScript.
- Vite.
- Supabase.
- PostgreSQL.
- RLS.
- RPC functions.
- Database triggers.
- Playwright E2E.
- Vercel.

The database and services contain important financial and operational rules.

Frontend components must not become an alternative source of truth.

## Product personality

TechRepair Pro should feel:

- Modern.
- Reliable.
- Fast.
- Professional.
- Technically capable.
- Easy to understand.
- Suitable for daily, repetitive use.
- Premium without being decorative.

Inspiration may come from:

- Linear.
- Stripe.
- Apple.
- High-quality modern SaaS tools.

Do not copy another product literally.

## Users

Users may be:

- Repair technicians.
- Shop owners.
- Salespeople.
- Cashiers.
- Managers.
- Administrative staff.

Not every user is technically advanced.

Labels, states and actions must be understandable without product training.

## Daily-use priority

This is operational software.

A visually impressive interface that slows down repetitive work is a failure.

Prioritize:

- Speed.
- Keyboard use.
- Scanner use.
- Clear confirmation.
- Error prevention.
- Predictable placement.
- Visible totals and statuses.
- Fast recovery from mistakes.

## Mi Guita

Mi Guita is a related but visually distinct personal-finance experience.

It belongs to the same product ecosystem but uses a separate identity.

Do not mix the two visual identities.

## Current POS checkpoint

Relevant stable checkpoint:

- `stable-pos-contrast-interaction-v1`
- Commit `69caee1`

The checkpoint improved:

- Text contrast.
- Borders.
- Product search.
- Focus states.
- Quick actions.
- Horizontal recent-product navigation.
- Checkout labels.
- Payment visibility.
- Dynamic Cobrar/Completar pago label.

Future POS work should build on that checkpoint instead of reverting it.
