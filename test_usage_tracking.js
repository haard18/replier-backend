require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { 
    auth: { 
      persistSession: false,
      autoRefreshToken: false 
    }
  }
);

const TEST_USER_ID = 'test_user_' + Date.now();

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function setupDatabase() {
  console.log('🔧 Setting up database...');
  
  try {
    // Read the migration SQL
    const fs = require('fs');
    const path = require('path');
    const migrationSQL = fs.readFileSync(
      path.join(__dirname, '../migrations/fix_usage_tracking.sql'), 
      'utf8'
    );

    // Execute migration SQL
    console.log('Running migration...');
    await supabase.rpc('execute_sql', { query: migrationSQL });
    
    console.log('✅ Database schema updated');
  } catch (e) {
    if (e.message.includes('Could not find')) {
      // If migration file not found, use inline SQL
      console.log('Migration file not found, using inline setup...');
      await supabase.rpc('execute_sql', {
        query: `
          -- Drop any existing problematic functions or triggers
          DROP TRIGGER IF EXISTS reset_usage_daily_trigger ON operator_usage;
          DROP TRIGGER IF EXISTS reset_usage_weekly_trigger ON operator_usage;
          DROP FUNCTION IF EXISTS reset_daily_usage();
          DROP FUNCTION IF EXISTS reset_weekly_usage();
          DROP FUNCTION IF EXISTS check_interval_trigger();

          -- Recreate table with correct schema
          DROP TABLE IF EXISTS operator_usage CASCADE;
          CREATE TABLE operator_usage (
            id SERIAL PRIMARY KEY,
            user_id TEXT UNIQUE NOT NULL,
            replies_sent_today INTEGER DEFAULT 0 CHECK (replies_sent_today >= 0),
            replies_sent_week INTEGER DEFAULT 0 CHECK (replies_sent_week >= 0),
            daily_goal INTEGER DEFAULT 10 CHECK (daily_goal > 0),
            weekly_goal INTEGER DEFAULT 50 CHECK (weekly_goal > 0),
            last_reset_date DATE DEFAULT CURRENT_DATE,
            last_reset_week_date DATE DEFAULT CURRENT_DATE,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
          );
        `
      });
    } else {
      console.error('Failed to setup database:', e.message);
      throw e;
    }
  }
  console.log('✅ Database ready for testing');
}

async function cleanupTestUser() {
  console.log('🧹 Cleaning up test user...');
  await supabase
    .from('operator_usage')
    .delete()
    .eq('user_id', TEST_USER_ID);
}

async function testUsageTracking() {
  try {
    // Set up fresh database
    await setupDatabase();
    
    console.log(`\n🧪 Testing usage tracking for user: ${TEST_USER_ID}`);
    
    // 1. Create new user record
    const today = new Date().toISOString().split('T')[0];
    
    console.log('\n📝 Creating new user record...');
    const { data: newUser, error: createError } = await supabase
      .from('operator_usage')
      .insert([{
        user_id: TEST_USER_ID,
        daily_goal: 10,
        weekly_goal: 50,
        replies_sent_today: 1,
        replies_sent_week: 1,
        last_reset_date: today,
        last_reset_week_date: today
      }])
      .select()
      .limit(1);

    if (createError) throw createError;
    console.log('✅ User record created:', newUser[0]);

    // 2. Simple increment test
    console.log('\n📈 Testing simple update...');
    const { data: updated, error: updateError } = await supabase
      .from('operator_usage')
      .update({
        replies_sent_today: 2,
        replies_sent_week: 2
      })
      .eq('user_id', TEST_USER_ID)
      .select()
      .limit(1);

    if (updateError) throw updateError;
    console.log('✅ Update successful:', updated[0]);

    console.log('\n✅ All tests completed successfully!');
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error);
  } finally {
    // Clean up test data
    await cleanupTestUser();
  }
}

// Run the tests
testUsageTracking().then(() => {
  console.log('\n🏁 Testing completed');
  process.exit(0);
}).catch(error => {
  console.error('\n💥 Fatal error:', error);
  process.exit(1);
});