/**
 * AI Reply Generator Backend Server
 * Express.js server that integrates with OpenAI API
 * 
 * Installation:
 * 1. cd backend
 * 2. npm install
 * 3. Create a .env file with: OPENAI_API_KEY=your_key_here
 * 4. npm start
 * 
 * The server will run on http://localhost:3000
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");

// Import Clerk backend SDK
let clerkClient;
try {
  const { createClerkClient } = require("@clerk/backend");
  clerkClient = createClerkClient({
    secretKey: process.env.CLERK_SECRET_KEY,
  });
  console.log("✅ Clerk backend client initialized");
} catch (error) {
  console.warn("⚠️ Clerk backend not available:", error.message);
  // Continue anyway - usage tracking will be skipped
}

// Import Supabase client for usage tracking
let supabase;
try {
  const { createClient } = require("@supabase/supabase-js");
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
    console.log("✅ Supabase client initialized");
  } else {
    console.warn("⚠️ Supabase not configured - usage tracking disabled");
  }
} catch (error) {
  console.warn("⚠️ Supabase initialization failed:", error.message);
}

// Verify API key BEFORE initializing anything
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("❌ ERROR: ANTHROPIC_API_KEY is not set in .env file");
  console.error("Please create a .env file with: ANTHROPIC_API_KEY=your_key_here");
  process.exit(1);
}

console.log("✅ Anthropic API key found");

// Now safely import and initialize Anthropic
let anthropic;
try {
  const Anthropic = require("@anthropic-ai/sdk");
  anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
  console.log("✅ Anthropic (Claude) client initialized");
} catch (error) {
  console.error("❌ Failed to initialize Anthropic:", error.message);
  console.error("Make sure you ran: npm install @anthropic-ai/sdk");
  process.exit(1);
}

// Initialize Express app
const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

/**
 * Clerk Token Validation Middleware
 * 
 * Validates the Clerk session token from the Authorization header.
 * The Chrome extension and web app send tokens in the format:
 * Authorization: Bearer <clerk_token>
 * 
 * This middleware validates the token and attaches user info to req.auth
 */
async function validateClerkToken(req, res, next) {
  // Skip validation for health check and public endpoints
  if (req.path === "/health" || req.path === "/" || req.path === "/favicon.ico") {
    return next();
  }

  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      // For backward compatibility, allow requests without auth for now
      // Remove this check in production for full token requirement
      console.warn("⚠️ Request without Authorization header:", req.path);
      req.auth = null;
      return next();
    }

    const token = authHeader.substring(7); // Remove "Bearer " prefix

    // Verify the Clerk token
    // In production, you should verify the signature using Clerk's public key
    // For now, we'll do basic validation
    try {
      // Clerk tokens are JWTs that we can decode
      // The token structure contains: header.payload.signature
      const parts = token.split(".");

      if (parts.length !== 3) {
        throw new Error("Invalid token format");
      }

      // Decode the payload (without verifying signature for now)
      // In production, use Clerk's SDK to verify: https://clerk.com/docs/backend-requests/handling/jwt-verification
      const payload = JSON.parse(
        Buffer.from(parts[1], "base64").toString("utf-8")
      );

      // Attach auth info to request
      req.auth = {
        userId: payload.sub || payload.uid, // Clerk user ID
        sessionId: payload.sid, // Session ID
        token: token,
      };

      console.log(`✅ Token validated for user: ${req.auth.userId}`);
      next();
    } catch (decodeError) {
      console.error("❌ Token decode error:", decodeError.message);
      // For development, log but allow. In production, reject
      req.auth = { token: token }; // Keep token for logging
      next();
    }
  } catch (error) {
    console.error("❌ Auth middleware error:", error.message);
    req.auth = null;
    next();
  }
}

// Apply auth middleware to all routes
app.use(validateClerkToken);

/**
 * Helper function to track usage in Supabase
 * Updates daily and weekly counters for the user
 * Returns updated usage stats
 */
async function trackUsageInSupabase(userId, tone = "value") {
  if (!userId || !supabase) {
    console.warn("⚠️ Supabase or userId not available for tracking");
    return null;
  }

  try {
    // Get or create user usage record - use limit(1) instead of .single()
    let { data: userData, error: selectError } = await supabase
      .from("operator_usage")
      .select("*")
      .eq("user_id", userId)
      .limit(1);

    if (selectError) {
      throw selectError;
    }

    // If user doesn't exist, create a new record
    if (!userData || userData.length === 0) {
      // Get today's date in YYYY-MM-DD format for Postgres
      const today = new Date().toISOString().split("T")[0];
      
      const { data: newUser, error: createError } = await supabase
        .from("operator_usage")
        .insert([
          {
            user_id: userId,
            daily_goal: 10,
            weekly_goal: 50,
            replies_sent_today: 1,
            replies_sent_week: 1,
            last_reset_date: today,
            last_reset_week_date: today
          },
        ])
        .select()
        .limit(1);

      if (createError) throw createError;
      if (!newUser || newUser.length === 0) throw new Error("Failed to create user record");
      userData = newUser[0];
      console.log(`📊 Created new user usage record for ${userId}`);
    } else {
      // Get the existing user record (first element from array)
      const user = userData[0];
      
      // Get today's date in YYYY-MM-DD format
      const today = new Date().toISOString().split("T")[0];
      
      // Build update object with simple increments
      // The database trigger will handle resets automatically
      const updateData = {
        replies_sent_today: user.replies_sent_today + 1,
        replies_sent_week: user.replies_sent_week + 1,
        last_reset_date: today
      };

      // Update the record - any resets will be handled by the database trigger
      const { data: updatedUser, error: updateError } = await supabase
        .from("operator_usage")
        .update(updateData)
        .eq("user_id", userId)
        .select()
        .limit(1);

      if (updateError) throw updateError;
      if (!updatedUser || updatedUser.length === 0) throw new Error("Failed to update user record");
      userData = updatedUser[0];
    }

    console.log(
      `📊 Usage tracked for user ${userId}: ${userData.replies_sent_today}/${userData.daily_goal} daily, ${userData.replies_sent_week}/${userData.weekly_goal} weekly`
    );

    return {
      usage_count: userData.replies_sent_today,
      daily_used: userData.replies_sent_today,
      daily_goal: userData.daily_goal,
      daily_remaining: Math.max(0, userData.daily_goal - userData.replies_sent_today),
      weekly_used: userData.replies_sent_week,
      weekly_goal: userData.weekly_goal,
      weekly_remaining: Math.max(0, userData.weekly_goal - userData.replies_sent_week),
    };
  } catch (error) {
    console.warn(`⚠️ Supabase tracking error for user ${userId}:`, error.message);
    return null;
  }
}

/**
 * Helper function to get current usage for a user
 * Returns current daily and weekly quota usage
 */
async function getUserUsage(userId) {
  if (!userId || !supabase) {
    return null;
  }

  try {
    // First ensure user exists
    let { data: userData, error } = await supabase
      .from("operator_usage")
      .select()
      .eq("user_id", userId)
      .limit(1);

    if (error) {
      console.warn(`⚠️ Error fetching usage for ${userId}:`, error.message);
      return null;
    }

    // If no record exists, create one with default values
    if (!userData || userData.length === 0) {
      const today = new Date().toISOString().split("T")[0];
      
      const { data: newUser, error: createError } = await supabase
        .from("operator_usage")
        .insert([{
          user_id: userId,
          daily_goal: 10,
          weekly_goal: 50,
          replies_sent_today: 0,
          replies_sent_week: 0,
          last_reset_date: today,
          last_reset_week_date: today
        }])
        .select()
        .limit(1);

      if (createError) {
        // If duplicate key error, it means another request created the record
        // Try fetching again
        if (createError.code === '23505') {
          const { data: retryData, error: retryError } = await supabase
            .from("operator_usage")
            .select()
            .eq("user_id", userId)
            .limit(1);
          
          if (retryError || !retryData || retryData.length === 0) {
            console.warn(`⚠️ Error fetching usage after duplicate key for ${userId}`);
            return null;
          }
          
          userData = retryData;
        } else {
          console.warn(`⚠️ Error creating usage for ${userId}:`, createError.message);
          return null;
        }
      } else {
        userData = newUser;
      }
    }

    const user = userData[0];

    return {
      usage_count: user.replies_sent_today,
      daily_used: user.replies_sent_today,
      daily_goal: user.daily_goal,
      daily_remaining: Math.max(0, user.daily_goal - user.replies_sent_today),
      weekly_used: user.replies_sent_week,
      weekly_goal: user.weekly_goal,
      weekly_remaining: Math.max(0, user.weekly_goal - user.replies_sent_week)
    };
  } catch (error) {
    console.warn(`⚠️ Error getting usage for ${userId}:`, error.message);
    return null;
  }
}

/**
 * Health check endpoint
 * Used by the extension to verify the backend is running
 */
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", message: "Backend is running" });
});

/**
 * Generate reply endpoint for LinkedIn
 * POST /generate/linkedin
 * 
 * Request body: { text: "original post text", tone: "funny" | "value" }
 * Response: JSON with reply text and usage stats
 * 
 * Authorization: Bearer <clerk_token> (optional, but required for usage tracking)
 */
app.post("/generate/linkedin", async (req, res) => {
  try {
    const { text, tone = "value" } = req.body;

    // Validate input
    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return res.status(400).json({
        error: "Invalid input. Please provide a 'text' field with post content.",
      });
    }

    // Validate tone
    if (!["funny", "value"].includes(tone)) {
      return res.status(400).json({
        error: "Invalid tone. Please use 'funny' or 'value'.",
      });
    }

    console.log(`📝 [LinkedIn] Generating reply for: "${text.substring(0, 50)}..." (tone: ${tone})`);
    if (req.auth?.userId) {
      console.log(`👤 User: ${req.auth.userId}`);
    }

    // Double-check Anthropic client exists
    if (!anthropic) {
      throw new Error("Anthropic client not initialized. Check your API key.");
    }

    // Build system prompt based on tone
    let systemPrompt;
    if (tone === "funny") {
      systemPrompt = `## Role: Witty Web3 Thought Leader for LinkedIn Comments
You are a **crypto and Web3 thought leader** known for witty, entertaining takes on blockchain, DeFi, and digital assets. Your job is to craft **short, clever comments** that make professionals smile and engage.

### Comment Guidelines

**Goal:** Deliver **concise, entertaining insights** — something that makes professionals laugh and share.

**Response Angles:**
1. Clever Technical Joke – Make a witty observation about the tech or market logic.
2. Humorous Contrarian Take – Respectfully challenge a common assumption with humor.
3. Funny Business Context – Link the post to broader industry trends with levity.
4. Witty Observation – Share a sharp, clever takeaway.

**Tone & Style:**
* Witty and authentic — not trying too hard, genuinely entertaining.
* 2–4 sentences max.
* Light humor and personality (but stay professional enough for LinkedIn).
* Clever wordplay when it fits naturally.
* Emojis are OK if they enhance the joke (but use sparingly).
* End with something memorable or funny.

**Output:** Provide **only the final LinkedIn comment**, written naturally as a witty Web3 professional. No labels or formatting — just the comment.`;
    } else {
      systemPrompt = `## Role: Web3 Thought Leader for LinkedIn Comments
You are a **crypto and Web3 thought leader** known for clear, insightful takes on blockchain, DeFi, and digital assets. Your job is to craft **short, high-impact comments** that add real value to professional discussions.

### Comment Guidelines

**Goal:** Deliver **concise, thoughtful insights** — something that makes professionals stop scrolling and think.

**Response Angles:**
1. Quick Technical Insight – Clarify or expand on the tech or market logic.
2. Contrarian Thought – Respectfully challenge a common assumption.
3. Business/Market Context – Link the post to broader industry or regulatory trends.
4. Lesson or Observation – Share a quick takeaway from experience.

**Tone & Style:**
* Professional and authentic — not corporate, not hyped.
* 2–4 sentences max.
* No emojis or hashtags.
* Speak like a peer in the industry — concise, credible, and real.
* End with a question or sharp observation when it fits.

**Output:** Provide **only the final LinkedIn comment**, written naturally as a Web3 professional. No labels or formatting — just the comment.`;
    }

    // Call Anthropic Claude API to generate a LinkedIn reply
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 150,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Generate a Web3 thought leader comment for this LinkedIn post:

"${text}"

Remember: Only provide the comment itself, nothing else.`,
        },
      ],
    });

    // Validate response structure
    if (!message || !message.content || message.content.length === 0) {
      throw new Error("Claude returned empty response");
    }

    // Extract the reply text
    const reply = message.content[0].type === "text" ? message.content[0].text : "";

    if (!reply) {
      return res.status(500).json({ error: "Failed to generate reply - empty response" });
    }

    console.log(`✅ [LinkedIn] Reply generated: "${reply.substring(0, 50)}..."`);

    // Track usage if user is authenticated
    let usageStats = null;
    if (req.auth?.userId) {
      usageStats = await trackUsageInSupabase(req.auth.userId, tone);
    }

    // Return the reply and usage stats
    res.status(200).json({
      reply: reply,
      tone: tone,
      platform: "linkedin",
      usage: usageStats,
    });
  } catch (error) {
    console.error("❌ [LinkedIn] Error generating reply:", error.message);
    console.error("Full error:", error);

    // Handle specific Anthropic errors
    if (error.status === 401 || error.message?.includes("401") || error.message?.includes("Unauthorized")) {
      return res.status(401).json({
        error: "Invalid Anthropic API key. Check your .env file.",
      });
    }

    if (error.status === 429 || error.message?.includes("429") || error.message?.includes("rate_limit")) {
      return res.status(429).json({
        error: "Rate limited by Anthropic. Please try again in a moment.",
      });
    }

    if (error.message?.includes("API key") || error.message?.includes("authentication")) {
      return res.status(401).json({
        error: "Anthropic API key issue: " + error.message,
      });
    }

    res.status(500).json({
      error: error.message || "An error occurred while generating the reply",
    });
  }
});

/**
 * Generate reply endpoint for Twitter/X
 * POST /generate/twitter
 * 
 * Request body: { text: "original post text", tone: "funny" | "value" }
 * Response: JSON with reply text and usage stats
 * 
 * Authorization: Bearer <clerk_token> (optional, but required for usage tracking)
 */
app.post("/generate/twitter", async (req, res) => {
  try {
    const { text, tone = "funny" } = req.body;

    // Validate input
    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return res.status(400).json({
        error: "Invalid input. Please provide a 'text' field with post content.",
      });
    }

    // Validate tone
    if (!["funny", "value"].includes(tone)) {
      return res.status(400).json({
        error: "Invalid tone. Please use 'funny' or 'value'.",
      });
    }

    console.log(`📝 [Twitter] Generating reply for: "${text.substring(0, 50)}..." (tone: ${tone})`);
    if (req.auth?.userId) {
      console.log(`👤 User: ${req.auth.userId}`);
    }

    // Double-check Anthropic client exists
    if (!anthropic) {
      throw new Error("Anthropic client not initialized. Check your API key.");
    }

    // Build system prompt based on tone
    let systemPrompt;
    if (tone === "funny") {
      systemPrompt = `## Role: Hilarious Web3 Personality for Twitter
You are a **fun, witty, and hilarious Web3 personality** on Twitter. Your replies are:
* Short, punchy, and entertaining (1-2 sentences max)
* Smart but casual — going for big laughs
* Use clever wordplay, memes references, or witty observations related to crypto/tech
* Include relevant emojis strategically
* End with something that makes people retweet
* Be authentic, slightly irreverent, and fun
* Make them want to engage and share

**Tone Examples:** "lmao this is the way 🔥" "based af" "giga chad energy" "tell me you're early without telling me you're early 👀" "not me 💀"

**Output:** Provide **only the tweet reply**, written naturally and hilariously. No explanations — just the reply.`;
    } else {
      systemPrompt = `## Role: Insightful Web3 Voice for Twitter
You are a **thoughtful and insightful Web3 voice** on Twitter. Your replies are:
* Concise but valuable (1-2 sentences max)
* Share real insights or perspective
* Professional but casual — speak like a peer
* Occasionally include relevant emojis
* End with something thought-provoking
* Build credibility and show expertise
* Spark meaningful conversation

**Tone Examples:** "this is the way ⛓️" "exactly - the market will price this in soon" "this is a fundamental shift in how we think about..." "key insight here �"

**Output:** Provide **only the tweet reply**, written naturally and insightfully. No explanations — just the reply.`;
    }

    // Call Anthropic Claude API to generate a Twitter reply
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 100,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Generate a Web3 comment for this Twitter post:

"${text}"

Remember: Keep it short (1-2 sentences), engaging, and use appropriate emojis. Only provide the reply itself, nothing else.`,
        },
      ],
    });

    // Validate response structure
    if (!message || !message.content || message.content.length === 0) {
      throw new Error("Claude returned empty response");
    }

    // Extract the reply text
    const reply = message.content[0].type === "text" ? message.content[0].text : "";

    if (!reply) {
      return res.status(500).json({ error: "Failed to generate reply - empty response" });
    }

    console.log(`✅ [Twitter] Reply generated: "${reply.substring(0, 50)}..."`);

    // Track usage if user is authenticated
    let usageStats = null;
    if (req.auth?.userId) {
      usageStats = await trackUsageInSupabase(req.auth.userId, tone);
    }

    // Return the reply and usage stats
    res.status(200).json({
      reply: reply,
      tone: tone,
      platform: "twitter",
      usage: usageStats,
    });
  } catch (error) {
    console.error("❌ [Twitter] Error generating reply:", error.message);
    console.error("Full error:", error);

    // Handle specific Anthropic errors
    if (error.status === 401 || error.message?.includes("401") || error.message?.includes("Unauthorized")) {
      return res.status(401).json({
        error: "Invalid Anthropic API key. Check your .env file.",
      });
    }

    if (error.status === 429 || error.message?.includes("429") || error.message?.includes("rate_limit")) {
      return res.status(429).json({
        error: "Rate limited by Anthropic. Please try again in a moment.",
      });
    }

    if (error.message?.includes("API key") || error.message?.includes("authentication")) {
      return res.status(401).json({
        error: "Anthropic API key issue: " + error.message,
      });
    }

    res.status(500).json({
      error: error.message || "An error occurred while generating the reply",
    });
  }
});

/**
 * Get user usage endpoint
 * GET /usage
 * 
 * Returns current usage stats for the authenticated user
 * Authorization: Bearer <clerk_token> (required)
 */
app.get("/usage", async (req, res) => {
  try {
    if (!req.auth?.userId) {
      return res.status(401).json({
        error: "Unauthorized - no authentication token provided",
      });
    }

    const usage = await getUserUsage(req.auth.userId);

    if (!usage) {
      // Return default values if not found
      return res.status(200).json({
        usage_count: 0,
        daily_used: 0,
        daily_goal: 10,
        daily_remaining: 10,
        weekly_used: 0,
        weekly_goal: 50,
        weekly_remaining: 50,
      });
    }

    res.status(200).json(usage);
  } catch (error) {
    console.error("❌ [Usage] Error fetching usage:", error.message);
    res.status(500).json({
      error: "Failed to fetch usage data",
    });
  }
});

/**
 * Legacy endpoint - auto-detects platform based on referer or defaults to LinkedIn
 * POST /generate
 */
app.post("/generate", async (req, res) => {
  const referer = req.get("referer") || "";
  const platform = referer.includes("x.com") || referer.includes("twitter.com") ? "twitter" : "linkedin";
  
  console.log(`📝 [Generate] Routing to ${platform} endpoint`);
  
  // Forward to appropriate endpoint by calling the route handlers
  if (platform === "twitter") {
    // Call Twitter handler
    const { text, tone } = req.body;
    req.body = { text, tone: tone || "funny" };
  } else {
    // Call LinkedIn handler
    const { text, tone } = req.body;
    req.body = { text, tone: tone || "value" };
  }
  
  // Use next() to proceed to the appropriate handler
  // by modifying the request path
  const originalPath = req.path;
  req.path = `/generate/${platform}`;
  req.url = `/generate/${platform}`;
  
  // Call the appropriate handler
  app._router.handle(req, res);
});

/**
 * Root endpoint - provides API documentation
 */
app.get("/", (req, res) => {
  res.json({
    name: "AI Reply Generator Backend",
    version: "1.0.0",
    endpoints: {
      health: "GET /health - Check if backend is running",
      generate:
        "POST /generate - Generate a reply (body: { text: 'post text' })",
    },
    docs: "See server.js for more information",
  });
});

/**
 * 404 handler
 */
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

/**
 * Error handler
 */
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

/**
 * Start the server
 */
app.listen(PORT, () => {
  console.log("\n");
  console.log("╔════════════════════════════════════════╗");
  console.log("║  AI Reply Generator Backend Server     ║");
  console.log("║  Running on: http://localhost:3000    ║");
  console.log("╚════════════════════════════════════════╝");
  console.log("\n");
  console.log("📚 Available endpoints:");
  console.log("   GET  /health - Check backend status");
  console.log("   POST /generate - Generate AI reply");
  console.log("\n");
  console.log("💡 The Chrome Extension will send requests here.");
  console.log("   Make sure the extension's API_ENDPOINT matches this URL.\n");
});

/**
 * Graceful shutdown
 */
process.on("SIGTERM", () => {
  console.log("\n🛑 Server shutting down...");
  process.exit(0);
});
