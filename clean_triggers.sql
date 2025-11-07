-- Drop problematic triggers and functions
DROP TRIGGER IF EXISTS reset_usage_daily_trigger ON operator_usage;
DROP TRIGGER IF EXISTS reset_usage_weekly_trigger ON operator_usage;
DROP FUNCTION IF EXISTS reset_daily_usage();
DROP FUNCTION IF EXISTS reset_weekly_usage();

-- Simplify the tables
ALTER TABLE operator_usage 
DROP COLUMN IF EXISTS created_at,
DROP COLUMN IF EXISTS updated_at;