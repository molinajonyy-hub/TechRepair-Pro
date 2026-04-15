-- Fix RLS for customers table (needed for comprobantes joins)
ALTER TABLE customers DISABLE ROW LEVEL SECURITY;

-- Or if you want to keep RLS but allow all access:
-- DROP POLICY IF EXISTS "customers_select" ON customers;
-- CREATE POLICY "customers_select" ON customers
--     FOR SELECT TO authenticated
--     USING (true);
