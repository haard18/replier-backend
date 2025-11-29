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
  console.error(
    "Please create a .env file with: ANTHROPIC_API_KEY=your_key_here"
  );
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

// Initialize OpenAI client for embeddings
let openai;
try {
  const OpenAI = require("openai");
  if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
    console.log("✅ OpenAI client initialized for embeddings");
  } else {
    console.warn("⚠️ OPENAI_API_KEY not set - RAG features disabled");
  }
} catch (error) {
  console.warn("⚠️ OpenAI initialization failed:", error.message);
}

// Import document processing and vector operations modules
const documentProcessor = require("./documentProcessor");
const vectorOperations = require("./vectorOperations");
const twitterService = require("./twitterService");
const toneService = require("./toneService");

// Initialize multer for file uploads
const multer = require("multer");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
});

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
  if (
    req.path === "/health" ||
    req.path === "/" ||
    req.path === "/favicon.ico"
  ) {
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
            last_reset_week_date: today,
          },
        ])
        .select()
        .limit(1);

      if (createError) throw createError;
      if (!newUser || newUser.length === 0)
        throw new Error("Failed to create user record");
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
        last_reset_date: today,
      };

      // Update the record - any resets will be handled by the database trigger
      const { data: updatedUser, error: updateError } = await supabase
        .from("operator_usage")
        .update(updateData)
        .eq("user_id", userId)
        .select()
        .limit(1);

      if (updateError) throw updateError;
      if (!updatedUser || updatedUser.length === 0)
        throw new Error("Failed to update user record");
      userData = updatedUser[0];
    }

    console.log(
      `📊 Usage tracked for user ${userId}: ${userData.replies_sent_today}/${userData.daily_goal} daily, ${userData.replies_sent_week}/${userData.weekly_goal} weekly`
    );

    return {
      usage_count: userData.replies_sent_today,
      daily_used: userData.replies_sent_today,
      daily_goal: userData.daily_goal,
      daily_remaining: Math.max(
        0,
        userData.daily_goal - userData.replies_sent_today
      ),
      weekly_used: userData.replies_sent_week,
      weekly_goal: userData.weekly_goal,
      weekly_remaining: Math.max(
        0,
        userData.weekly_goal - userData.replies_sent_week
      ),
    };
  } catch (error) {
    console.warn(
      `⚠️ Supabase tracking error for user ${userId}:`,
      error.message
    );
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
        .insert([
          {
            user_id: userId,
            daily_goal: 10,
            weekly_goal: 50,
            replies_sent_today: 0,
            replies_sent_week: 0,
            last_reset_date: today,
            last_reset_week_date: today,
          },
        ])
        .select()
        .limit(1);

      if (createError) {
        // If duplicate key error, it means another request created the record
        // Try fetching again
        if (createError.code === "23505") {
          const { data: retryData, error: retryError } = await supabase
            .from("operator_usage")
            .select()
            .eq("user_id", userId)
            .limit(1);

          if (retryError || !retryData || retryData.length === 0) {
            console.warn(
              `⚠️ Error fetching usage after duplicate key for ${userId}`
            );
            return null;
          }

          userData = retryData;
        } else {
          console.warn(
            `⚠️ Error creating usage for ${userId}:`,
            createError.message
          );
          return null;
        }
      } else {
        userData = newUser;
      }
    }
    console.log(userData);
    const user = userData[0];

    return {
      usage_count: user.replies_sent_today,
      daily_used: user.replies_sent_today,
      daily_goal: user.daily_goal,
      daily_remaining: Math.max(0, user.daily_goal - user.replies_sent_today),
      weekly_used: user.replies_sent_week,
      weekly_goal: user.weekly_goal,
      weekly_remaining: Math.max(0, user.weekly_goal - user.replies_sent_week),
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
 * Request body: { text: "original post text", tone: "funny" | "value", emojiBool: boolean }
 * Response: JSON with reply text and usage stats
 *
 * Authorization: Bearer <clerk_token> (optional, but required for usage tracking)
 */
app.post("/generate/linkedin", async (req, res) => {
  try {
    const {
      text,
      tone = "value",
      emojiBool,
      web3Bool = true,
      companyId,
      authorName,
    } = req.body;

    // Validate input
    if (
      !text ||
      typeof text !== "string" ||
      text.trim().length === 0 ||
      emojiBool === undefined
    ) {
      return res.status(400).json({
        error:
          "Invalid input. Please provide a 'text' field with post content.",
      });
    }

    // Validate minimum text length to prevent poor quality responses
    if (text.trim().length < 20) {
      return res.status(400).json({
        error:
          "Post text too short. Minimum 20 characters required for quality replies.",
      });
    }

    // Optional: Validate maximum length to prevent token waste
    if (text.trim().length > 5000) {
      return res.status(400).json({
        error:
          "Post text too long. Maximum 5000 characters allowed.",
      });
    }

    // Validate tone
    if (!["funny", "value"].includes(tone)) {
      return res.status(400).json({
        error: "Invalid tone. Please use 'funny' or 'value'.",
      });
    }

    console.log(
      `📝 [LinkedIn] Generating reply for: "${text.substring(
        0,
        50
      )}..." (tone: ${tone}, web3: ${web3Bool})`
    );
    if (req.auth?.userId) {
      console.log(`👤 User: ${req.auth.userId}`);
    }

    // Double-check Anthropic client exists
    if (!anthropic) {
      throw new Error("Anthropic client not initialized. Check your API key.");
    }

    // Fetch operator tone profile if available (Twitter-based personalization)
    let operatorTone = null;
    if (req.auth?.userId && supabase) {
      try {
        const { data: toneData } = await supabase
          .from("operator_tones")
          .select("tone_json")
          .eq("operator_id", req.auth.userId)
          .single();

        if (toneData && toneData.tone_json) {
          operatorTone = toneData.tone_json;
          console.log(
            `✅ [Tone] Loaded operator tone profile for ${req.auth.userId}`
          );
        }
      } catch (error) {
        // Tone profile is optional, continue without it
        console.log(`ℹ️ [Tone] No tone profile found for ${req.auth.userId}`);
      }
    }

    // Build RAG context if companyId provided
    let ragContext = null;
    if (companyId && supabase && openai) {
      try {
        console.log(`🧠 [RAG] Building context for company ${companyId}`);
        ragContext = await vectorOperations.buildRagContext({
          supabase,
          openaiClient: openai,
          companyId,
          postText: text,
          maxChunks: 10,
          similarityThreshold: 0.7,
        });
        console.log(
          `✅ [RAG] Retrieved ${ragContext.chunks.length} relevant chunks`
        );
      } catch (error) {
        console.warn(
          `⚠️ [RAG] Error building context for company ${companyId}:`,
          error.message
        );
        console.warn(
          `💡 Hint: Visit the Knowledge page first to create a company and upload documents.`
        );
        // Continue without RAG context
      }
    } else if (companyId && (!supabase || !openai)) {
      console.warn(
        `⚠️ [RAG] CompanyId provided but RAG not available (Supabase: ${!!supabase}, OpenAI: ${!!openai})`
      );
    }

    // Build system prompt based on tone and web3 setting
    let systemPrompt;
    if (tone === "funny" && web3Bool) {
      systemPrompt = `## Role: Sharp Web3 Commentator for LinkedIn

You are a Web3 professional known for witty, intelligent commentary. Your comments are clever WITHOUT being try-hard.

### Core Principles

**Understand the Post Type:**
- **Engagement Bait:** If the post is clearly designed to farm engagement (fake hiring posts, obvious ragebait, "agree?" posts, generic motivation), call it out cleverly or subvert expectations
- **Genuine Discussion:** If it's real industry discussion, add sharp insight
- **Comment Thread:** If replying to someone's comment (not the main post), respond directly to THEIR point, not the original post

**Comment Quality:**
1. Read carefully - understand what's ACTUALLY being said
2. Add genuine insight or clever observation
3. Be specific to THIS post, not generic Web3 commentary
4. If it's engagement bait, be playfully skeptical

**Tone & Style:**
* Sharp and authentic - smart humor, not forced jokes
* 2-3 sentences maximum
* ONE emoji maximum, ONLY at the very end if needed
* ${emojiBool ? "Maximum 1 emoji at the end only" : "NO emojis allowed"}
* Never use em-dashes, excessive punctuation, or emoji spam
* Sound like a real person, not a content creator

**Examples of Good Replies:**

Post: "We're hiring a senior Solidity developer! Must have 10 years experience."
Bad: "Solidity has only been around for 9 years! 😂🔥💯"
Good: "Solidity launched in 2014. Might want to adjust those requirements."

Post: "Hot take: Web3 will replace Web2 by 2025"
Bad: "Lol no way this is happening 💀😂"
Good: "We said this about Web2 replacing Web1 by 2010. Turns out they coexist."

Comment: "I think gas fees will always be a problem"
Bad: "Actually L2s solve this with rollups and zkProofs! 🚀"
Good: "L2s have dropped fees 95%+ already. The UX problem is wallets, not cost."

**Critical Rules:**
- Match the depth of the original post
- If replying to a comment, address THAT person's specific point
- No emoji spam (max 1, only at end)
- No generic platitudes
- Be genuinely helpful or genuinely funny, not both
- NEVER just rephrase the original post. Add a new angle.

**Output:** Only the comment text. No labels, no quotes, no explanations.`;
    } else if (tone === "funny" && !web3Bool) {
      systemPrompt = `## Role: Sharp Professional Commentator for LinkedIn

You are a professional known for witty, intelligent commentary. Your comments are clever WITHOUT being try-hard.

### Core Principles

**Understand the Post Type:**
- **Engagement Bait:** If the post is clearly designed to farm engagement (fake hiring posts, obvious ragebait, "agree?" posts, generic motivation), call it out cleverly or subvert expectations
- **Genuine Discussion:** If it's real industry discussion, add sharp insight
- **Comment Thread:** If replying to someone's comment (not the main post), respond directly to THEIR point, not the original post

**Comment Quality:**
1. Read carefully - understand what's ACTUALLY being said
2. Add genuine insight or clever observation
3. Be specific to THIS post, not generic commentary
4. If it's engagement bait, be playfully skeptical

**Tone & Style:**
* Sharp and authentic - smart humor, not forced jokes
* 2-3 sentences maximum
* ONE emoji maximum, ONLY at the very end if needed
* ${emojiBool ? "Maximum 1 emoji at the end only" : "NO emojis allowed"}
* Never use em-dashes, excessive punctuation, or emoji spam
* Sound like a real person, not a content creator

**Examples of Good Replies:**

Post: "We're hiring a senior developer! Must have 10 years experience in a 5-year-old framework."
Bad: "Math isn't mathing! 😂🔥💯"
Good: "Time travel experience required. Will accept DeLorean certification."

Post: "Hot take: AI will replace all jobs by 2025"
Bad: "Lol no way this is happening 💀😂"
Good: "We said this about Excel in 1985. Turns out spreadsheets just created new jobs."

Comment: "I think remote work is just a fad"
Bad: "Bro it's 2025 wake up 💀"
Good: "Companies spent billions on office space they can't fill. That's not a fad, that's sunk cost."

**Critical Rules:**
- Match the depth of the original post
- If replying to a comment, address THAT person's specific point
- No emoji spam (max 1, only at end)
- No generic platitudes
- Be genuinely helpful or genuinely funny, not both
- NEVER just rephrase the original post. Add a new angle.

**Output:** Only the comment text. No labels, no quotes, no explanations.`;
    } else if (tone === "value" && web3Bool) {
      systemPrompt = `## Role: Insightful Web3 Professional for LinkedIn

You are a Web3 professional known for clear, valuable commentary. Your comments add genuine insight.

### Core Principles

**Understand the Post Type:**
- **Engagement Bait:** If the post is clearly designed to farm engagement (fake hiring posts, obvious ragebait, "agree?" posts), either skip engagement or add genuinely useful context
- **Genuine Discussion:** Add real insight, data, or perspective
- **Comment Thread:** If replying to someone's comment (not the main post), respond directly to THEIR specific point

**Comment Quality:**
1. Read carefully - understand the actual argument being made
2. Add specific insight, not generic observations
3. Reference real trends, data, or technical details when relevant
4. If it's engagement bait, either ignore or provide actual value

**Tone & Style:**
* Professional and direct - peer-to-peer conversation
* 2-3 sentences maximum
* ONE emoji maximum, ONLY at the very end if appropriate
* ${emojiBool ? "Maximum 1 emoji at the end only" : "NO emojis allowed"}
* Never use em-dashes or excessive punctuation
* Avoid buzzwords and hype - be substantive
* Sound like an expert colleague, not a motivational speaker

**Examples of Good Replies:**

Post: "DeFi is dead, no one uses it anymore"
Bad: "Not true! DeFi TVL is still strong 💪📈"
Good: "DeFi TVL is $50B+, down from $180B peak but higher than 2020. Real issue is most users are yield chasers, not organic activity."

Post: "What's the future of blockchain?"
Bad: "Blockchain will revolutionize everything! Bright future ahead 🚀"
Good: "Infrastructure is maturing. Next phase is applications that hide the blockchain - users shouldn't need to know it exists."

Comment: "I don't think NFTs have real utility"
Bad: "NFTs are about digital ownership and provenance! 🎨"
Good: "Event tickets, certification, and supply chain tracking are working use cases. Profile pictures were just the first retail experiment."

**Critical Rules:**
- Be specific and substantive
- If replying to a comment, address THAT person's exact point
- No emoji spam (max 1, only at end)
- No generic statements that could apply to any post
- Add information or perspective they don't already have
- NEVER just rephrase the original post. Provide NEW info.

**Output:** Only the comment text. No labels, no quotes, no explanations.`;
    } else {
      // tone === "value" && !web3Bool
      systemPrompt = `## Role: Insightful Professional for LinkedIn

You are a professional known for clear, valuable commentary. Your comments add genuine insight.

### Core Principles

**Understand the Post Type:**
- **Engagement Bait:** If the post is clearly designed to farm engagement (fake hiring posts, obvious ragebait, "agree?" posts), either skip engagement or add genuinely useful context
- **Genuine Discussion:** Add real insight, data, or perspective
- **Comment Thread:** If replying to someone's comment (not the main post), respond directly to THEIR specific point

**Comment Quality:**
1. Read carefully - understand the actual argument being made
2. Add specific insight, not generic observations
3. Reference real trends, data, or relevant details when appropriate
4. If it's engagement bait, either ignore or provide actual value

**Tone & Style:**
* Professional and direct - peer-to-peer conversation
* 2-3 sentences maximum
* ONE emoji maximum, ONLY at the very end if appropriate
* ${emojiBool ? "Maximum 1 emoji at the end only" : "NO emojis allowed"}
* Never use em-dashes or excessive punctuation
* Avoid buzzwords and hype - be substantive
* Sound like an expert colleague, not a motivational speaker

**Examples of Good Replies:**

Post: "Remote work is destroying productivity"
Bad: "Not true! Studies show remote workers are more productive 💪📈"
Good: "Microsoft's 2024 study shows remote workers complete 13% more tasks, but collaboration dropped 25%. It's not binary - hybrid models address both."

Post: "What's the future of AI in business?"
Bad: "AI will revolutionize everything! Bright future ahead 🚀"
Good: "Process automation and data analysis are the immediate wins. Customer-facing AI still struggles with edge cases - that's where humans remain critical."

Comment: "I don't think certifications matter anymore"
Bad: "Certifications show commitment and knowledge! 🎓"
Good: "Certifications validate baseline knowledge, but portfolio work demonstrates real capability. For hiring, I weight projects 3x higher than certs."

**Critical Rules:**
- Be specific and substantive
- If replying to a comment, address THAT person's exact point
- No emoji spam (max 1, only at end)
- No generic statements that could apply to any post
- Add information or perspective they don't already have
- NEVER just rephrase the original post. Provide NEW info.

**Output:** Only the comment text. No labels, no quotes, no explanations.`;
    }

    // // Enhance system prompt with operator tone profile if available
    // if (operatorTone) {
    //   systemPrompt += `\n\n---\n\n## CRITICAL: Personal Writing Style\n\n`;
    //   systemPrompt += `You must write in the operator's authentic voice. This is their actual writing style from Twitter:\n\n`;
    //   systemPrompt += toneService.formatToneForPrompt(operatorTone);
    //   systemPrompt += `\n**IMPORTANT:** Replicate this exact writing style while following the role guidelines above. The response should sound like THIS person wrote it.`;
    // }

    // Enhance system prompt with RAG context if available
    if (ragContext && ragContext.hasContext) {
      systemPrompt += `\n\n---\n\n## IMPORTANT: Company-Specific Context\n\n`;

      if (ragContext.formattedVoice) {
        systemPrompt += `### Company Voice & Brand Guidelines:\n${ragContext.formattedVoice}\n\n`;
      }

      if (ragContext.formattedChunks) {
        systemPrompt += `### Relevant Company Knowledge:\nUse the following information from the company's knowledge base to inform your reply. Only reference this if relevant to the post.\n\n${ragContext.formattedChunks}\n\n`;
      }

      systemPrompt += `**CRITICAL:** Align your reply with the company's voice and use relevant knowledge naturally. Do NOT hallucinate facts outside the provided context.`;
    }

    // Call Anthropic Claude API to generate a LinkedIn reply
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 200,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Generate a ${
            web3Bool ? "Web3 " : ""
          }professional comment for this LinkedIn post or comment:

"${text}"${authorName ? `\n\nAuthor: ${authorName}` : ""}

Context: This could be a main post or a reply to someone's comment. Read it carefully and respond appropriately.${authorName ? ` When appropriate, you may address the author by name (${authorName}) to make your comment more personal and engaging.` : ""}

CRITICAL: Do NOT regurgitate or rephrase the original text. You must add NEW information, a counter-point, or a relevant question.

Remember: Only provide the comment itself, nothing else. No quotes, no labels.`,
        },
      ],
    });

    // Validate response structure
    if (!message || !message.content || message.content.length === 0) {
      throw new Error("Claude returned empty response");
    }

    // Extract the reply text
    const reply =
      message.content[0].type === "text" ? message.content[0].text : "";

    if (!reply) {
      return res
        .status(500)
        .json({ error: "Failed to generate reply - empty response" });
    }

    console.log(
      `✅ [LinkedIn] Reply generated: "${reply.substring(0, 50)}..."`
    );

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
    if (
      error.status === 401 ||
      error.message?.includes("401") ||
      error.message?.includes("Unauthorized")
    ) {
      return res.status(401).json({
        error: "Invalid Anthropic API key. Check your .env file.",
      });
    }

    if (
      error.status === 429 ||
      error.message?.includes("429") ||
      error.message?.includes("rate_limit")
    ) {
      return res.status(429).json({
        error: "Rate limited by Anthropic. Please try again in a moment.",
      });
    }

    if (
      error.message?.includes("API key") ||
      error.message?.includes("authentication")
    ) {
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
    const {
      text,
      tone,
      emojiBool,
      web3Bool ,
      companyId,
      tweetId,
      authorName,
    } = req.body;

    // Validate input
    if (
      !text ||
      typeof text !== "string" ||
      text.trim().length === 0 ||
      emojiBool === undefined
    ) {
      return res.status(400).json({
        error:
          "Invalid input. Please provide a 'text' field with post content.",
      });
    }

    // Validate minimum text length to prevent poor quality responses
    if (text.trim().length < 20) {
      return res.status(400).json({
        error:
          "Post text too short. Minimum 20 characters required for quality replies.",
      });
    }

    // Optional: Validate maximum length to prevent token waste
    if (text.trim().length > 5000) {
      return res.status(400).json({
        error:
          "Post text too long. Maximum 5000 characters allowed.",
      });
    }

    if (tweetId && typeof tweetId !== "string") {
      return res.status(400).json({
        error: "Invalid tweetId. It must be a string.",
      });
    }

    // Validate tone
    if (!["funny", "value"].includes(tone)) {
      return res.status(400).json({
        error: "Invalid tone. Please use 'funny' or 'value'.",
      });
    }

    console.log(
      `📝 [Twitter] Generating reply for: "${text.substring(
        0,
        50
      )}..." (tone: ${tone}, web3: ${web3Bool}) with companyId: ${companyId} tweetId: ${
        tweetId || "N/A"
      }`
    );
    if (req.auth?.userId) {
      console.log(`👤 User: ${req.auth.userId}`);
    }

    // Double-check Anthropic client exists
    if (!anthropic) {
      throw new Error("Anthropic client not initialized. Check your API key.");
    }

    // Fetch operator tone profile if available (Twitter-based personalization)
    let operatorTone = null;
    if (req.auth?.userId && supabase) {
      try {
        const { data: toneData } = await supabase
          .from("operator_tones")
          .select("tone_json")
          .eq("operator_id", req.auth.userId)
          .single();

        if (toneData && toneData.tone_json) {
          operatorTone = toneData.tone_json;
          console.log(
            `✅ [Tone] Loaded operator tone profile for ${req.auth.userId}`
          );
        }
      } catch (error) {
        // Tone profile is optional, continue without it
        console.log(`ℹ️ [Tone] No tone profile found for ${req.auth.userId}`);
      }
    }

    // Build RAG context if companyId provided
    let ragContext = null;
    if (companyId) {
      try {
        console.log(`🧠 [RAG] Building context for company ${companyId}`);
        ragContext = await vectorOperations.buildRagContext({
          supabase,
          openaiClient: openai,
          companyId,
          postText: text,
          maxChunks: 8, // Slightly fewer for Twitter's shorter format
          similarityThreshold: 0.7,
        });
        console.log(
          `✅ [RAG] Retrieved ${ragContext.chunks.length} relevant chunks`
        );
      } catch (error) {
        console.warn(
          `⚠️ [RAG] Error building context for company ${companyId}:`,
          error.message
        );
        console.warn(
          `💡 Hint: Visit the Knowledge page first to create a company and upload documents.`
        );
        // Continue without RAG context
      }
    } else if (companyId && (!supabase || !openai)) {
      console.warn(
        `⚠️ [RAG] CompanyId provided but RAG not available (Supabase: ${!!supabase}, OpenAI: ${!!openai})`
      );
    }

    // Fetch existing replies for additional context
    let tweetReplies = [];
    if (tweetId) {
      try {
        tweetReplies = await twitterService.fetchTweetReplies(tweetId, 10);
        console.log(
          `💬 [Twitter] Loaded ${tweetReplies.length} replies for tweet ${tweetId}`
        );
      } catch (replyError) {
        console.warn(
          `⚠️ [Twitter] Could not load replies for tweet ${tweetId}:`,
          replyError.message
        );
      }
    }

    const repliesContextText =
      tweetReplies.length > 0
        ? `\n\nRecent replies already in the thread (most recent first):\n${tweetReplies
            .map((reply, index) => {
              const author = reply.authorUsername
                ? `@${reply.authorUsername}`
                : reply.authorName || "Unknown user";
              const metrics =
                reply.likeCount && reply.likeCount > 0
                  ? ` • ${reply.likeCount} likes`
                  : "";
              return `${index + 1}. ${author}${metrics}: ${reply.text}`;
            })
            .join(
              "\n"
            )}\n\nUse these to understand the conversation flow. Do NOT repeat them verbatim.`
        : "";

    // Build system prompt based on tone and web3 setting
    let systemPrompt;
    // Replace the systemPrompt section with these improved versions:

    // FUNNY + WEB3
    if (tone === "funny" && web3Bool) {
      systemPrompt = `## Role: Conversational Web3 Voice

You're having a natural Twitter conversation. Be witty, make a sharp observation, then ask something that invites dialogue.

### Core Principles

**Read the Context:**
- What's the actual point they're making?
- If it's a reply thread, respond to their specific argument
- Understand the vibe - are they serious, joking, or engagement farming?

**Conversational Structure:**
1. React naturally to what they said (witty observation or light joke)
2. End with a genuine question that continues the conversation
3. Sound like a friend jumping into the thread

**Style:**
* Natural, flowing sentences - like you're texting a friend
* 2-3 short sentences max
* ${emojiBool ? "1-2 emojis only, at the end" : "NO emojis"}
* End with a question that shows curiosity
* No forced memes or crypto jargon spam

**Examples:**

Tweet: "Just paid $50 in gas fees to move $30"
Reply: "That's a very expensive lesson in timing. What were you even trying to move?"

Tweet: "Web3 gaming will replace AAA games soon"
Reply: "We can barely load a 2D metaverse without lag. What game are you playing that makes you think we're ready?"

Reply to: "ETH is dead, everyone's moving to Solana"
Reply: "Interesting take after the 7th outage this year. What makes you think it's more reliable long-term?"

**Critical Rules:**
- React first, then question
- Questions should be genuine, not rhetorical dunks
- Sound curious, not confrontational
- Keep it conversational and flowing
- NEVER just rephrase the original post. Add a new angle.

**Output:** Only the reply. No quotes, labels, or explanations.`;
    }

    // FUNNY + NON-WEB3
    else if (tone === "funny" && !web3Bool) {
      systemPrompt = `## Role: Conversational Professional Voice

You're having a natural Twitter conversation. Be witty, make a sharp observation, then ask something that invites dialogue.

### Core Principles

**Read the Context:**
- What's the actual point they're making?
- If it's a reply thread, respond to their specific argument
- Understand the vibe - are they serious, joking, or engagement farming?

**Conversational Structure:**
1. React naturally to what they said (witty observation or light joke)
2. End with a genuine question that continues the conversation
3. Sound like a friend jumping into the thread

**Style:**
* Natural, flowing sentences - like you're texting a friend
* 2-3 short sentences max
* ${emojiBool ? "1-2 emojis only, at the end" : "NO emojis"}
* End with a question that shows curiosity
* No forced jokes or corporate speak

**Examples:**

Tweet: "Just spent 3 hours in a meeting that could have been an email"
Reply: "At least they probably had snacks. Did anyone actually take action items or just nod along?"

Tweet: "AI will replace all creative jobs"
Reply: "It still draws hands like eldritch horrors. Which creative job do you think goes first?"

Reply to: "Coffee is overrated"
Reply: "Bold stance from presumably a tea person. What's your drink of choice that's so much better?"

**Critical Rules:**
- React first, then question
- Questions should be genuine, not rhetorical dunks
- Sound curious, not confrontational
- Keep it conversational and flowing
- NEVER just rephrase the original post. Add a new angle.

**Output:** Only the reply. No quotes, labels, or explanations.`;
    }

    // VALUE + WEB3
    else if (tone === "value" && web3Bool) {
      systemPrompt = `## Role: Thoughtful Web3 Voice

You're adding substance to a Twitter conversation. Share insight or data, then ask something that deepens the discussion.

### Core Principles

**Read the Context:**
- What's the core argument or claim?
- If it's a reply thread, engage with their specific point
- Add information they might not have considered

**Conversational Structure:**
1. Make your point with substance (data, context, or technical insight)
2. End with a question that explores the topic further
3. Sound like a peer sharing knowledge, not lecturing

**Style:**
* Clear, direct sentences
* 2-3 sentences max
* Maximum 1 emoji at the end if it fits
* End with a genuine question that invites deeper thinking
* Skip hype words and buzzwords

**Examples:**

Tweet: "ETH is too expensive for normal users"
Reply: "L2s like Base and Arbitrum are under $0.10 per transaction now. Are you using them or still defaulting to mainnet?"

Tweet: "NFTs are just JPEGs with no value"
Reply: "Event tickets and game items are proving utility beyond profile pics. What use case would actually convince you there's value here?"

Reply to: "DeFi has no real users"
Reply: "Aave processes $2B monthly in actual loans. The issue is 90% is yield farming, not organic borrowing. What would real adoption look like to you?"

**Critical Rules:**
- Lead with substance, end with curiosity
- Questions should advance the conversation
- Show you're interested in their perspective
- Be informative but conversational
- NEVER just rephrase the original post. Provide NEW info or a specific question.

**Output:** Only the reply. No quotes, labels, or explanations.`;
    }

    // VALUE + NON-WEB3
    else {
      systemPrompt = `## Role: Thoughtful Professional Voice

You're adding substance to a Twitter conversation. Share insight or data, then ask something that deepens the discussion.

### Core Principles

**Read the Context:**
- What's the core argument or claim?
- If it's a reply thread, engage with their specific point
- Add information they might not have considered

**Conversational Structure:**
1. Make your point with substance (data, context, or insight)
2. End with a question that explores the topic further
3. Sound like a peer sharing knowledge, not lecturing

**Style:**
* Clear, direct sentences
* 2-3 sentences max
* Maximum 1 emoji at the end if it fits
* End with a genuine question that invites deeper thinking
* Skip buzzwords and corporate jargon

**Examples:**

Tweet: "Remote work kills company culture"
Reply: "GitLab scaled to 2000+ employees fully remote with strong culture. What specific cultural elements do you think require physical proximity?"

Tweet: "Marketing is just manipulation"
Reply: "Marketing is distribution - bad products manipulate, good products educate. What's an example of marketing you think was actually valuable?"

Reply to: "Degrees are worthless now"
Reply: "College grads still earn 67% more lifetime, though ROI varies wildly by major. What alternative path do you think provides better outcomes?"

**Critical Rules:**
- Lead with substance, end with curiosity
- Questions should advance the conversation
- Show you're interested in their perspective
- Be informative but conversational
- NEVER just rephrase the original post. Provide NEW info or a specific question.

**Output:** Only the reply. No quotes, labels, or explanations.`;
    }



    // Enhance system prompt with RAG context if available
    if (ragContext && ragContext.hasContext) {
      systemPrompt += `\n\n---\n\n## IMPORTANT: Company-Specific Context\n\n`;

      if (ragContext.formattedVoice) {
        systemPrompt += `### Company Voice & Brand Guidelines:\n${ragContext.formattedVoice}\n\n`;
      }

      if (ragContext.formattedChunks) {
        systemPrompt += `### Relevant Company Knowledge:\nUse the following information from the company's knowledge base to inform your reply. Only reference this if relevant to the tweet.\n\n${ragContext.formattedChunks}\n\n`;
      }

      systemPrompt += `**CRITICAL:** Align your reply with the company's voice and use relevant knowledge naturally. Do NOT hallucinate facts outside the provided context.`;
    }

    // Call Anthropic Claude API to generate a Twitter reply
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 120,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Generate a ${
            web3Bool ? "Web3 " : ""
          }comment for this Twitter post or reply:

"${text}"${authorName ? `\n\nAuthor: ${authorName}` : ""}

${repliesContextText}

Context: This could be a main tweet or a reply to someone. Read carefully and respond appropriately.${authorName ? ` When appropriate, you may address the author by name (${authorName}) to make your comment more personal and engaging.` : ""}

CRITICAL: Do NOT regurgitate or rephrase the original text. You must add NEW information, a counter-point, or a relevant question.

Remember: Keep it short (1-2 sentences), maximum 2 emojis at the END only. Only provide the reply itself, nothing else.`,
        },
      ],
    });

    // Validate response structure
    if (!message || !message.content || message.content.length === 0) {
      throw new Error("Claude returned empty response");
    }

    // Extract the reply text
    const reply =
      message.content[0].type === "text" ? message.content[0].text : "";

    if (!reply) {
      return res
        .status(500)
        .json({ error: "Failed to generate reply - empty response" });
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
    if (
      error.status === 401 ||
      error.message?.includes("401") ||
      error.message?.includes("Unauthorized")
    ) {
      return res.status(401).json({
        error: "Invalid Anthropic API key. Check your .env file.",
      });
    }

    if (
      error.status === 429 ||
      error.message?.includes("429") ||
      error.message?.includes("rate_limit")
    ) {
      return res.status(429).json({
        error: "Rate limited by Anthropic. Please try again in a moment.",
      });
    }

    if (
      error.message?.includes("API key") ||
      error.message?.includes("authentication")
    ) {
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
    console.log(usage);
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
 * AutoMode endpoint - Generate reply for a specific post
 * POST /generateAuto
 *
 * Request body: { 
 *   post_id: string, 
 *   post_text: string, 
 *   tone: "funny" | "value",
 *   platform: "twitter" | "linkedin"
 * }
 * Response: { reply: string, post_id: string, url: string }
 *
 * This endpoint is specifically for AutoMode - it generates a reply
 * and returns the post URL for navigation-based automation.
 */
app.post("/generateAuto", async (req, res) => {
  try {
    const {
      post_id,
      post_text,
      tone = "funny",
      platform = "twitter",
      emojiBool = true,
      web3Bool = true,
      companyId,
      authorName,
    } = req.body;

    // Validate input
    if (!post_id || !post_text || typeof post_text !== "string") {
      return res.status(400).json({
        error: "Invalid input. Please provide post_id and post_text.",
      });
    }

    // Validate tone
    if (!["funny", "value"].includes(tone)) {
      return res.status(400).json({
        error: "Invalid tone. Please use 'funny' or 'value'.",
      });
    }

    // Validate platform
    if (!["twitter", "linkedin"].includes(platform)) {
      return res.status(400).json({
        error: "Invalid platform. Please use 'twitter' or 'linkedin'.",
      });
    }

    console.log(
      `📝 [AutoMode] Generating reply for ${platform} post: ${post_id}`
    );
    if (req.auth?.userId) {
      console.log(`👤 User: ${req.auth.userId}`);
    }

    // Use the same logic as /generate/twitter or /generate/linkedin
    // but return with URL for navigation

    // For now, forward to the appropriate endpoint internally
    const endpoint = platform === "twitter" ? "twitter" : "linkedin";
    const metadata = platform === "twitter" ? { tweetId: post_id } : {};

    // Fetch operator tone profile if available
    let operatorTone = null;
    if (req.auth?.userId && supabase) {
      try {
        const { data: toneData } = await supabase
          .from("operator_tones")
          .select("tone_json")
          .eq("operator_id", req.auth.userId)
          .single();

        if (toneData && toneData.tone_json) {
          operatorTone = toneData.tone_json;
          console.log(
            `✅ [Tone] Loaded operator tone profile for ${req.auth.userId}`
          );
        }
      } catch (error) {
        console.log(`ℹ️ [Tone] No tone profile found for ${req.auth.userId}`);
      }
    }

    // Build RAG context if companyId provided
    let ragContext = null;
    if (companyId && supabase && openai) {
      try {
        console.log(`🧠 [RAG] Building context for company ${companyId}`);
        ragContext = await vectorOperations.buildRagContext({
          supabase,
          openaiClient: openai,
          companyId,
          postText: post_text,
          maxChunks: platform === "twitter" ? 8 : 10,
          similarityThreshold: 0.7,
        });
        console.log(
          `✅ [RAG] Retrieved ${ragContext.chunks.length} relevant chunks`
        );
      } catch (error) {
        console.warn(
          `⚠️ [RAG] Error building context for company ${companyId}:`,
          error.message
        );
      }
    }

    // Build system prompt (use same prompts as main endpoints for consistency)
    let systemPrompt;
    if (platform === "twitter") {
      // FUNNY + WEB3
      if (tone === "funny" && web3Bool) {
        systemPrompt = `## Role: Conversational Web3 Voice

You're having a natural Twitter conversation. Be witty, make a sharp observation, then ask something that invites dialogue.

### Core Principles

**Read the Context:**
- What's the actual point they're making?
- If it's a reply thread, respond to their specific argument
- Understand the vibe - are they serious, joking, or engagement farming?

**Conversational Structure:**
1. React naturally to what they said (witty observation or light joke)
2. End with a genuine question that continues the conversation
3. Sound like a friend jumping into the thread

**Style:**
* Natural, flowing sentences - like you're texting a friend
* 2-3 short sentences max
* ${emojiBool ? "1-2 emojis only, at the end" : "NO emojis"}
* End with a question that shows curiosity
* No forced memes or crypto jargon spam

**Critical Rules:**
- React first, then question
- Questions should be genuine, not rhetorical dunks
- Sound curious, not confrontational
- Keep it conversational and flowing

**Output:** Only the reply. No quotes, labels, or explanations.`;
      }
      // FUNNY + NON-WEB3
      else if (tone === "funny" && !web3Bool) {
        systemPrompt = `## Role: Conversational Professional Voice

You're having a natural Twitter conversation. Be witty, make a sharp observation, then ask something that invites dialogue.

### Core Principles

**Read the Context:**
- What's the actual point they're making?
- If it's a reply thread, respond to their specific argument
- Understand the vibe - are they serious, joking, or engagement farming?

**Conversational Structure:**
1. React naturally to what they said (witty observation or light joke)
2. End with a genuine question that continues the conversation
3. Sound like a friend jumping into the thread

**Style:**
* Natural, flowing sentences - like you're texting a friend
* 2-3 short sentences max
* ${emojiBool ? "1-2 emojis only, at the end" : "NO emojis"}
* End with a question that shows curiosity
* No forced jokes or corporate speak

**Critical Rules:**
- React first, then question
- Questions should be genuine, not rhetorical dunks
- Sound curious, not confrontational
- Keep it conversational and flowing

**Output:** Only the reply. No quotes, labels, or explanations.`;
      }
      // VALUE + WEB3
      else if (tone === "value" && web3Bool) {
        systemPrompt = `## Role: Thoughtful Web3 Voice

You're adding substance to a Twitter conversation. Share insight or data, then ask something that deepens the discussion.

### Core Principles

**Read the Context:**
- What's the core argument or claim?
- If it's a reply thread, engage with their specific point
- Add information they might not have considered

**Conversational Structure:**
1. Make your point with substance (data, context, or technical insight)
2. End with a question that explores the topic further
3. Sound like a peer sharing knowledge, not lecturing

**Style:**
* Clear, direct sentences
* 2-3 sentences max
* Maximum 1 emoji at the end if it fits
* End with a genuine question that invites deeper thinking
* Skip hype words and buzzwords

**Critical Rules:**
- Lead with substance, end with curiosity
- Questions should advance the conversation
- Show you're interested in their perspective
- Be informative but conversational

**Output:** Only the reply. No quotes, labels, or explanations.`;
      }
      // VALUE + NON-WEB3
      else {
        systemPrompt = `## Role: Thoughtful Professional Voice

You're adding substance to a Twitter conversation. Share insight or data, then ask something that deepens the discussion.

### Core Principles

**Read the Context:**
- What's the core argument or claim?
- If it's a reply thread, engage with their specific point
- Add information they might not have considered

**Conversational Structure:**
1. Make your point with substance (data, context, or insight)
2. End with a question that explores the topic further
3. Sound like a peer sharing knowledge, not lecturing

**Style:**
* Clear, direct sentences
* 2-3 sentences max
* Maximum 1 emoji at the end if it fits
* End with a genuine question that invites deeper thinking
* Skip buzzwords and corporate jargon

**Critical Rules:**
- Lead with substance, end with curiosity
- Questions should advance the conversation
- Show you're interested in their perspective
- Be informative but conversational

**Output:** Only the reply. No quotes, labels, or explanations.`;
      }
    } else {
      // LinkedIn prompts (use same as /generate/linkedin)
      if (tone === "funny" && web3Bool) {
        systemPrompt = `## Role: Sharp Web3 Commentator for LinkedIn

You are a Web3 professional known for witty, intelligent commentary. Your comments are clever WITHOUT being try-hard.

**Comment Quality:**
1. Read carefully - understand what's ACTUALLY being said
2. Add genuine insight or clever observation
3. Be specific to THIS post, not generic Web3 commentary

**Tone & Style:**
* Sharp and authentic - smart humor, not forced jokes
* 2-3 sentences maximum
* ONE emoji maximum, ONLY at the very end if needed
* ${emojiBool ? "Maximum 1 emoji at the end only" : "NO emojis allowed"}
* Never use em-dashes, excessive punctuation, or emoji spam
* Sound like a real person, not a content creator

**Critical Rules:**
- Match the depth of the original post
- No emoji spam (max 1, only at end)
- No generic platitudes
- Be genuinely helpful or genuinely funny, not both

**Output:** Only the comment text. No labels, no quotes, no explanations.`;
      } else if (tone === "funny" && !web3Bool) {
        systemPrompt = `## Role: Sharp Professional Commentator for LinkedIn

You are a professional known for witty, intelligent commentary. Your comments are clever WITHOUT being try-hard.

**Comment Quality:**
1. Read carefully - understand what's ACTUALLY being said
2. Add genuine insight or clever observation
3. Be specific to THIS post, not generic commentary

**Tone & Style:**
* Sharp and authentic - smart humor, not forced jokes
* 2-3 sentences maximum
* ONE emoji maximum, ONLY at the very end if needed
* ${emojiBool ? "Maximum 1 emoji at the end only" : "NO emojis allowed"}
* Never use em-dashes, excessive punctuation, or emoji spam
* Sound like a real person, not a content creator

**Critical Rules:**
- Match the depth of the original post
- No emoji spam (max 1, only at end)
- No generic platitudes
- Be genuinely helpful or genuinely funny, not both

**Output:** Only the comment text. No labels, no quotes, no explanations.`;
      } else if (tone === "value" && web3Bool) {
        systemPrompt = `## Role: Insightful Web3 Professional for LinkedIn

You are a Web3 professional known for clear, valuable commentary. Your comments add genuine insight.

**Comment Quality:**
1. Read carefully - understand the actual argument being made
2. Add specific insight, not generic observations
3. Reference real trends, data, or technical details when relevant

**Tone & Style:**
* Professional and direct - peer-to-peer conversation
* 2-3 sentences maximum
* ONE emoji maximum, ONLY at the very end if appropriate
* ${emojiBool ? "Maximum 1 emoji at the end only" : "NO emojis allowed"}
* Never use em-dashes or excessive punctuation
* Avoid buzzwords and hype - be substantive
* Sound like an expert colleague, not a motivational speaker

**Critical Rules:**
- Be specific and substantive
- No emoji spam (max 1, only at end)
- No generic statements that could apply to any post
- Add information or perspective they don't already have

**Output:** Only the comment text. No labels, no quotes, no explanations.`;
      } else {
        systemPrompt = `## Role: Insightful Professional for LinkedIn

You are a professional known for clear, valuable commentary. Your comments add genuine insight.

**Comment Quality:**
1. Read carefully - understand the actual argument being made
2. Add specific insight, not generic observations
3. Reference real trends, data, or relevant details when appropriate

**Tone & Style:**
* Professional and direct - peer-to-peer conversation
* 2-3 sentences maximum
* ONE emoji maximum, ONLY at the very end if appropriate
* ${emojiBool ? "Maximum 1 emoji at the end only" : "NO emojis allowed"}
* Never use em-dashes or excessive punctuation
* Avoid buzzwords and hype - be substantive
* Sound like an expert colleague, not a motivational speaker

**Critical Rules:**
- Be specific and substantive
- No emoji spam (max 1, only at end)
- No generic statements that could apply to any post
- Add information or perspective they don't already have

**Output:** Only the comment text. No labels, no quotes, no explanations.`;
      }
    }

    // Enhance with operator tone if available
    if (operatorTone) {
      systemPrompt += `\n\nIMPORTANT: Write in the operator's authentic voice:\n`;
      systemPrompt += toneService.formatToneForPrompt(operatorTone);
    }

    // Enhance with RAG context if available
    if (ragContext && ragContext.hasContext) {
      if (ragContext.formattedVoice) {
        systemPrompt += `\n\nCompany Voice:\n${ragContext.formattedVoice}\n`;
      }
      if (ragContext.formattedChunks) {
        systemPrompt += `\n\nCompany Knowledge:\n${ragContext.formattedChunks}\n`;
      }
    }

    // Call Anthropic Claude API
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: platform === "twitter" ? 120 : 200,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Generate a reply for this ${platform} post:\n\n"${post_text}"${authorName ? `\n\nAuthor: ${authorName}` : ""}\n\n${authorName ? `When appropriate, you may address the author by name (${authorName}) to make your comment more personal and engaging. ` : ""}Only provide the reply text, nothing else.`,
        },
      ],
    });

    const reply =
      message.content[0].type === "text" ? message.content[0].text : "";

    if (!reply) {
      return res
        .status(500)
        .json({ error: "Failed to generate reply - empty response" });
    }

    console.log(`✅ [AutoMode] Reply generated: "${reply.substring(0, 50)}..."`);

    // Track usage if user is authenticated
    let usageStats = null;
    if (req.auth?.userId) {
      usageStats = await trackUsageInSupabase(req.auth.userId, tone);
    }

    // Construct URL based on platform and post_id
    let url;
    if (platform === "twitter") {
      // For Twitter, we need the username too (if available in post_id format)
      // Assume post_id might be in format "username:tweetId" or just "tweetId"
      if (post_id.includes(":")) {
        const [username, tweetId] = post_id.split(":");
        url = `https://x.com/${username}/status/${tweetId}`;
      } else {
        // Just tweet ID - we'll need to construct or use a generic URL
        // For now, return without username (will be added by extension)
        url = `https://x.com/i/web/status/${post_id}`;
      }
    } else {
      // LinkedIn - post_id is already the URL or URN
      url = post_id.startsWith("http")
        ? post_id
        : `https://www.linkedin.com/feed/update/${post_id}/`;
    }

    // Return reply with URL for AutoMode navigation
    res.status(200).json({
      reply: reply,
      post_id: post_id,
      url: url,
      tone: tone,
      platform: platform,
      usage: usageStats,
    });
  } catch (error) {
    console.error("❌ [AutoMode] Error generating reply:", error.message);
    console.error("Full error:", error);

    res.status(500).json({
      error: error.message || "An error occurred while generating the reply",
    });
  }
});

/**
 * Legacy endpoint - auto-detects platform based on referer or defaults to LinkedIn
 * POST /generate
 */
app.post("/generate", async (req, res) => {
  const referer = req.get("referer") || "";
  const platform =
    referer.includes("x.com") || referer.includes("twitter.com")
      ? "twitter"
      : "linkedin";

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

// ==========================================
// COMPANY KNOWLEDGE & RAG ENDPOINTS
// ==========================================

/**
 * Create or get company for a user
 * POST /company/ensure
 *
 * Request: { user_id: string, name?: string }
 * Response: { company_id: string }
 */
app.post("/company/ensure", async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: "Supabase not configured" });
  }

  if (!req.auth?.userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const userId = req.auth.userId;
  const { name } = req.body;

  try {
    // Check if user already has a company
    const { data: existingCompany, error: checkError } = await supabase
      .from("companies")
      .select("id")
      .eq("owner_user_id", userId)
      .limit(1);

    if (checkError) {
      throw checkError;
    }

    // If company exists, return it
    if (existingCompany && existingCompany.length > 0) {
      return res.status(200).json({
        company_id: existingCompany[0].id,
        existed: true,
      });
    }

    // Create new company
    const { data: newCompany, error: createError } = await supabase
      .from("companies")
      .insert([
        {
          owner_user_id: userId,
          name: name || `${userId}'s Company`,
          description: "Auto-created company for knowledge base",
        },
      ])
      .select()
      .single();

    if (createError) {
      throw createError;
    }

    // Add user as owner in memberships
    await supabase.from("user_company_memberships").insert([
      {
        user_id: userId,
        company_id: newCompany.id,
        role: "owner",
      },
    ]);

    console.log(`✅ Created company ${newCompany.id} for user ${userId}`);

    res.status(201).json({
      company_id: newCompany.id,
      existed: false,
    });
  } catch (error) {
    console.error("❌ [Ensure Company] Error:", error);
    res
      .status(500)
      .json({ error: error.message || "Failed to ensure company" });
  }
});

/**
 * Upload document to company knowledge base
 * POST /company/:companyId/upload
 *
 * Request: multipart/form-data with 'file' field
 * Response: { document_id, chunks_created, status }
 */
app.post(
  "/company/:companyId/upload",
  upload.single("file"),
  async (req, res) => {
    if (!supabase || !openai) {
      return res.status(503).json({
        error: "RAG features not available - Supabase or OpenAI not configured",
      });
    }

    if (!req.auth?.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { companyId } = req.params;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    try {
      console.log(
        `📤 [Upload] Processing file: ${file.originalname} for company ${companyId}`
      );

      // Determine file type
      const fileExtension = file.originalname.split(".").pop().toLowerCase();
      const supportedTypes = ["pdf", "docx", "txt", "md"];

      if (!supportedTypes.includes(fileExtension)) {
        return res.status(400).json({
          error: `Unsupported file type: ${fileExtension}. Supported: ${supportedTypes.join(
            ", "
          )}`,
        });
      }

      // Create document record
      const { data: document, error: docError } = await supabase
        .from("company_documents")
        .insert([
          {
            company_id: companyId,
            filename: file.originalname,
            file_type: fileExtension,
            file_size: file.size,
            status: "processing",
          },
        ])
        .select()
        .single();

      if (docError) {
        throw docError;
      }

      console.log(`📄 Created document record: ${document.id}`);

      // Process document in background
      processDocumentAsync(document.id, file.buffer, fileExtension, companyId);

      res.status(202).json({
        document_id: document.id,
        status: "processing",
        message:
          "Document is being processed. Check status with GET /company/:companyId/documents/:documentId",
      });
    } catch (error) {
      console.error("❌ [Upload] Error:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to upload document" });
    }
  }
);

/**
 * Upload URL to company knowledge base
 * POST /company/:companyId/upload-url
 *
 * Request: { url: "https://example.com" }
 * Response: { document_id, chunks_created, status }
 */
app.post("/company/:companyId/upload-url", async (req, res) => {
  if (!supabase || !openai) {
    return res.status(503).json({
      error: "RAG features not available - Supabase or OpenAI not configured",
    });
  }

  if (!req.auth?.userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { companyId } = req.params;
  const { url } = req.body;

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "URL is required" });
  }

  try {
    console.log(
      `📤 [Upload URL] Processing URL: ${url} for company ${companyId}`
    );

    // Create document record
    const { data: document, error: docError } = await supabase
      .from("company_documents")
      .insert([
        {
          company_id: companyId,
          filename: url,
          file_type: "url",
          source_url: url,
          status: "processing",
        },
      ])
      .select()
      .single();

    if (docError) {
      throw docError;
    }

    console.log(`📄 Created document record: ${document.id}`);

    // Process URL in background
    processUrlAsync(document.id, url, companyId);

    res.status(202).json({
      document_id: document.id,
      status: "processing",
      message:
        "URL is being processed. Check status with GET /company/:companyId/documents/:documentId",
    });
  } catch (error) {
    console.error("❌ [Upload URL] Error:", error);
    res.status(500).json({ error: error.message || "Failed to upload URL" });
  }
});

/**
 * Get company knowledge base status
 * GET /company/:companyId/status
 *
 * Response: { total_documents, total_chunks, total_tokens, total_storage_bytes, last_updated, voice_settings }
 */
app.get("/company/:companyId/status", async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: "Supabase not configured" });
  }

  if (!req.auth?.userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { companyId } = req.params;

  try {
    // Get stats
    const stats = await vectorOperations.getCompanyStats(supabase, companyId);

    // Get voice settings
    const voiceSettings = await vectorOperations.getCompanyVoiceSettings(
      supabase,
      companyId
    );

    res.status(200).json({
      ...stats,
      voice_settings: voiceSettings,
    });
  } catch (error) {
    console.error("❌ [Status] Error:", error);
    res.status(500).json({ error: error.message || "Failed to get status" });
  }
});

/**
 * Get all documents for a company
 * GET /company/:companyId/documents
 *
 * Response: { documents: [...] }
 */
app.get("/company/:companyId/documents", async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: "Supabase not configured" });
  }

  if (!req.auth?.userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { companyId } = req.params;

  try {
    const { data, error } = await supabase
      .from("company_documents")
      .select("*")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false });

    if (error) {
      throw error;
    }

    res.status(200).json({ documents: data });
  } catch (error) {
    console.error("❌ [Documents] Error:", error);
    res.status(500).json({ error: error.message || "Failed to get documents" });
  }
});

/**
 * Get single document details
 * GET /company/:companyId/documents/:documentId
 *
 * Response: { document: {...} }
 */
app.get("/company/:companyId/documents/:documentId", async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: "Supabase not configured" });
  }

  if (!req.auth?.userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { companyId, documentId } = req.params;

  try {
    const { data, error } = await supabase
      .from("company_documents")
      .select("*")
      .eq("id", documentId)
      .eq("company_id", companyId)
      .single();

    if (error) {
      throw error;
    }

    res.status(200).json({ document: data });
  } catch (error) {
    console.error("❌ [Document] Error:", error);
    res.status(500).json({ error: error.message || "Failed to get document" });
  }
});

/**
 * Delete a document and its chunks
 * DELETE /company/:companyId/documents/:documentId
 *
 * Response: { success: true }
 */
app.delete("/company/:companyId/documents/:documentId", async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: "Supabase not configured" });
  }

  if (!req.auth?.userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { companyId, documentId } = req.params;

  try {
    // Delete document (chunks will cascade)
    const { error } = await supabase
      .from("company_documents")
      .delete()
      .eq("id", documentId)
      .eq("company_id", companyId);

    if (error) {
      throw error;
    }

    res.status(200).json({ success: true, message: "Document deleted" });
  } catch (error) {
    console.error("❌ [Delete Document] Error:", error);
    res
      .status(500)
      .json({ error: error.message || "Failed to delete document" });
  }
});

/**
 * Get company voice settings
 * GET /company/:companyId/settings
 *
 * Response: { voice_settings: {...} }
 */
app.get("/company/:companyId/settings", async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: "Supabase not configured" });
  }

  if (!req.auth?.userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { companyId } = req.params;

  try {
    const settings = await vectorOperations.getCompanyVoiceSettings(
      supabase,
      companyId
    );

    res.status(200).json({ voice_settings: settings });
  } catch (error) {
    console.error("❌ [Get Settings] Error:", error);
    res.status(500).json({ error: error.message || "Failed to get settings" });
  }
});

/**
 * Update company voice settings
 * PUT /company/:companyId/settings
 *
 * Request: { voice_guidelines, brand_tone, positioning, metadata }
 * Response: { voice_settings: {...} }
 */
app.put("/company/:companyId/settings", async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: "Supabase not configured" });
  }

  if (!req.auth?.userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { companyId } = req.params;
  const settings = req.body;

  try {
    const updatedSettings = await vectorOperations.upsertCompanyVoiceSettings(
      supabase,
      companyId,
      settings
    );

    res.status(200).json({ voice_settings: updatedSettings });
  } catch (error) {
    console.error("❌ [Update Settings] Error:", error);
    res
      .status(500)
      .json({ error: error.message || "Failed to update settings" });
  }
});

// ==========================================
// OPERATOR TONE PROFILE ENDPOINTS
// ==========================================

/**
 * Create operator tone profile from Twitter
 * POST /operator/tone/create
 *
 * Request: { operator_id: string, twitter_url: string }
 * Response: { tone_profile: {...}, message: string }
 */
app.post("/operator/tone/create", async (req, res) => {
  if (!supabase || !anthropic) {
    return res.status(503).json({
      error:
        "Tone profile features not available - Supabase or Anthropic not configured",
    });
  }

  if (!req.auth?.userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { twitter_url } = req.body;
  const operatorId = req.auth.userId;

  if (!twitter_url) {
    return res.status(400).json({ error: "twitter_url is required" });
  }

  try {
    console.log(
      `🐦 [Tone Create] Creating tone profile for operator ${operatorId} from ${twitter_url}`
    );

    // Extract username from URL
    const username = twitterService.extractUsername(twitter_url);
    console.log(`📝 Extracted username: @${username}`);

    // Fetch tweets (using mock for now until Twitter.io API is configured)
    // To use real API, replace fetchTweetsMock with fetchTweets
    let tweets;
    try {
      // Try real API first if TWITTER_IO_API_KEY is set
      if (process.env.TWITTER_IO_API_KEY) {
        tweets = await twitterService.fetchTweets(username, 150);
      } else {
        console.log("⚠️ TWITTER_IO_API_KEY not set, using mock data");
        tweets = await twitterService.fetchTweetsMock(username);
      }
    } catch (fetchError) {
      console.warn(
        `⚠️ Twitter API failed, using mock data: ${fetchError.message}`
      );
      tweets = await twitterService.fetchTweetsMock(username);
    }

    if (!tweets || tweets.length === 0) {
      return res.status(400).json({
        error:
          "No valid tweets found. User may have no posts or account is private.",
      });
    }

    console.log(`✅ Retrieved ${tweets.length} tweets for analysis`);

    // Generate tone profile using Claude
    const toneProfile = await toneService.generateToneProfile(
      anthropic,
      tweets
    );

    // Check if profile already exists
    const { data: existingProfile } = await supabase
      .from("operator_tones")
      .select("id")
      .eq("operator_id", operatorId)
      .limit(1);

    let result;
    if (existingProfile && existingProfile.length > 0) {
      // Update existing profile
      const { data, error } = await supabase
        .from("operator_tones")
        .update({
          twitter_url: twitter_url,
          twitter_username: username,
          tone_json: toneProfile,
          last_learned_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("operator_id", operatorId)
        .select()
        .single();

      if (error) throw error;
      result = data;
      console.log(`✅ Updated existing tone profile for ${operatorId}`);
    } else {
      // Create new profile
      const { data, error } = await supabase
        .from("operator_tones")
        .insert([
          {
            operator_id: operatorId,
            twitter_url: twitter_url,
            twitter_username: username,
            tone_json: toneProfile,
            last_learned_at: new Date().toISOString(),
          },
        ])
        .select()
        .single();

      if (error) throw error;
      result = data;
      console.log(`✅ Created new tone profile for ${operatorId}`);
    }

    res.status(200).json({
      tone_profile: result.tone_json,
      twitter_username: result.twitter_username,
      last_learned_at: result.last_learned_at,
      message: "Tone profile created successfully",
    });
  } catch (error) {
    console.error("❌ [Tone Create] Error:", error);
    res.status(500).json({
      error: error.message || "Failed to create tone profile",
    });
  }
});

/**
 * Get operator tone profile
 * GET /operator/tone/:operatorId
 *
 * Response: { tone_profile: {...}, twitter_username: string, last_learned_at: timestamp }
 */
app.get("/operator/tone/:operatorId", async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: "Supabase not configured" });
  }

  // Allow getting your own profile or any profile (for now)
  // In production, you might want to restrict this
  const { operatorId } = req.params;

  try {
    const { data, error } = await supabase
      .from("operator_tones")
      .select("*")
      .eq("operator_id", operatorId)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return res.status(404).json({
          error: "Tone profile not found for this operator",
        });
      }
      throw error;
    }

    res.status(200).json({
      tone_profile: data.tone_json,
      twitter_username: data.twitter_username,
      twitter_url: data.twitter_url,
      last_learned_at: data.last_learned_at,
      created_at: data.created_at,
    });
  } catch (error) {
    console.error("❌ [Tone Get] Error:", error);
    res.status(500).json({
      error: error.message || "Failed to get tone profile",
    });
  }
});

/**
 * Retrain operator tone profile (force immediate re-learning)
 * POST /operator/tone/retrain
 *
 * Request: { operator_id?: string } (if not provided, uses authenticated user)
 * Response: { tone_profile: {...}, message: string }
 */
app.post("/operator/tone/retrain", async (req, res) => {
  if (!supabase || !anthropic) {
    return res.status(503).json({
      error: "Tone profile features not available",
    });
  }

  if (!req.auth?.userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const operatorId = req.body.operator_id || req.auth.userId;

  // Only allow retraining your own profile
  if (operatorId !== req.auth.userId) {
    return res.status(403).json({
      error: "You can only retrain your own tone profile",
    });
  }

  try {
    console.log(`🔄 [Tone Retrain] Retraining tone profile for ${operatorId}`);

    // Get existing profile to retrieve Twitter URL
    const { data: existingProfile, error: fetchError } = await supabase
      .from("operator_tones")
      .select("*")
      .eq("operator_id", operatorId)
      .single();

    if (fetchError) {
      return res.status(404).json({
        error: "No existing tone profile found. Please create one first.",
      });
    }

    const twitter_url = existingProfile.twitter_url;
    const username =
      existingProfile.twitter_username ||
      twitterService.extractUsername(twitter_url);

    // Fetch fresh tweets
    let tweets;
    try {
      if (process.env.TWITTER_IO_API_KEY) {
        tweets = await twitterService.fetchTweets(username, 150);
      } else {
        console.log("⚠️ TWITTER_IO_API_KEY not set, using mock data");
        tweets = await twitterService.fetchTweetsMock(username);
      }
    } catch (fetchError) {
      console.warn(
        `⚠️ Twitter API failed, using mock data: ${fetchError.message}`
      );
      tweets = await twitterService.fetchTweetsMock(username);
    }

    if (!tweets || tweets.length === 0) {
      return res.status(400).json({
        error: "No valid tweets found for retraining",
      });
    }

    // Generate new tone profile
    const toneProfile = await toneService.generateToneProfile(
      anthropic,
      tweets
    );

    // Update profile
    const { data, error } = await supabase
      .from("operator_tones")
      .update({
        tone_json: toneProfile,
        last_learned_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("operator_id", operatorId)
      .select()
      .single();

    if (error) throw error;

    console.log(`✅ Successfully retrained tone profile for ${operatorId}`);

    res.status(200).json({
      tone_profile: data.tone_json,
      twitter_username: data.twitter_username,
      last_learned_at: data.last_learned_at,
      message: "Tone profile retrained successfully",
    });
  } catch (error) {
    console.error("❌ [Tone Retrain] Error:", error);
    res.status(500).json({
      error: error.message || "Failed to retrain tone profile",
    });
  }
});

// ==========================================
// BACKGROUND PROCESSING FUNCTIONS
// ==========================================

/**
 * Process document asynchronously (runs in background)
 */
async function processDocumentAsync(
  documentId,
  fileBuffer,
  fileType,
  companyId
) {
  try {
    console.log(`🔄 Processing document ${documentId}...`);

    // Process document
    const result = await documentProcessor.processDocument(
      fileBuffer,
      fileType
    );

    // Generate embeddings for all chunks
    console.log(
      `🧠 Generating embeddings for ${result.chunks.length} chunks...`
    );
    const chunkTexts = result.chunks.map((c) => c.content);
    const embeddings = await documentProcessor.generateEmbeddingsBatch(
      chunkTexts,
      openai
    );

    // Store chunks
    console.log(`💾 Storing chunks in vector database...`);
    const chunksStored = await vectorOperations.storeChunks(
      supabase,
      companyId,
      documentId,
      result.chunks,
      embeddings
    );

    // Update document status
    await supabase
      .from("company_documents")
      .update({
        status: "completed",
        total_chunks: chunksStored,
        total_tokens: result.totalTokens,
      })
      .eq("id", documentId);

    console.log(`✅ Document ${documentId} processed successfully`);
  } catch (error) {
    console.error(`❌ Error processing document ${documentId}:`, error);

    // Update document with error
    await supabase
      .from("company_documents")
      .update({
        status: "failed",
        error_message: error.message,
      })
      .eq("id", documentId);
  }
}

/**
 * Process URL asynchronously (runs in background)
 */
async function processUrlAsync(documentId, url, companyId) {
  try {
    console.log(`🔄 Processing URL ${documentId}...`);

    // Process URL
    const result = await documentProcessor.processUrl(url);

    // Generate embeddings for all chunks
    console.log(
      `🧠 Generating embeddings for ${result.chunks.length} chunks...`
    );
    const chunkTexts = result.chunks.map((c) => c.content);
    const embeddings = await documentProcessor.generateEmbeddingsBatch(
      chunkTexts,
      openai
    );

    // Store chunks
    console.log(`💾 Storing chunks in vector database...`);
    const chunksStored = await vectorOperations.storeChunks(
      supabase,
      companyId,
      documentId,
      result.chunks,
      embeddings
    );

    // Update document status
    await supabase
      .from("company_documents")
      .update({
        status: "completed",
        total_chunks: chunksStored,
        total_tokens: result.totalTokens,
      })
      .eq("id", documentId);

    console.log(`✅ URL ${documentId} processed successfully`);
  } catch (error) {
    console.error(`❌ Error processing URL ${documentId}:`, error);

    // Update document with error
    await supabase
      .from("company_documents")
      .update({
        status: "failed",
        error_message: error.message,
      })
      .eq("id", documentId);
  }
}

/**
 * Root endpoint - provides API documentation
 */
app.get("/", (req, res) => {
  res.json({
    name: "AI Reply Generator Backend",
    version: "2.0.0",
    endpoints: {
      health: "GET /health - Check if backend is running",
      generate:
        "POST /generate - Generate a reply (body: { text: 'post text' })",
      usage: "GET /usage - Get current usage stats",
      companyUpload:
        "POST /company/:id/upload - Upload document to company knowledge",
      companyUploadUrl:
        "POST /company/:id/upload-url - Add URL to company knowledge",
      companyStatus: "GET /company/:id/status - Get company knowledge stats",
      companyDocuments: "GET /company/:id/documents - List company documents",
      companySettings: "GET /company/:id/settings - Get company voice settings",
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

// ==========================================
// AUTOMATIC TONE PROFILE RE-LEARNING
// ==========================================

const cron = require("node-cron");

/**
 * Automatic tone profile re-learning job
 * Runs daily at 2 AM, checks for profiles that are 30+ days old
 * and automatically re-learns them
 */
if (supabase && anthropic) {
  // Schedule: Run every day at 2:00 AM
  cron.schedule("0 2 * * *", async () => {
    try {
      console.log("\n🔄 [Cron] Starting automatic tone profile re-learning...");

      // Find profiles that need re-learning (30+ days old)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const { data: staleProfiles, error } = await supabase
        .from("operator_tones")
        .select("*")
        .lt("last_learned_at", thirtyDaysAgo.toISOString());

      if (error) {
        throw error;
      }

      if (!staleProfiles || staleProfiles.length === 0) {
        console.log("✅ [Cron] No profiles need re-learning");
        return;
      }

      console.log(
        `🔄 [Cron] Found ${staleProfiles.length} profiles to re-learn`
      );

      // Process each profile
      let successCount = 0;
      let failCount = 0;

      for (const profile of staleProfiles) {
        try {
          console.log(
            `🔄 [Cron] Re-learning profile for operator ${profile.operator_id}...`
          );

          const username =
            profile.twitter_username ||
            twitterService.extractUsername(profile.twitter_url);

          // Fetch fresh tweets
          let tweets;
          try {
            if (process.env.TWITTER_IO_API_KEY) {
              tweets = await twitterService.fetchTweets(username, 150);
            } else {
              tweets = await twitterService.fetchTweetsMock(username);
            }
          } catch (fetchError) {
            console.warn(
              `⚠️ [Cron] Twitter API failed for @${username}, using mock data`
            );
            tweets = await twitterService.fetchTweetsMock(username);
          }

          if (!tweets || tweets.length === 0) {
            console.warn(
              `⚠️ [Cron] No tweets found for @${username}, skipping`
            );
            failCount++;
            continue;
          }

          // Generate new tone profile
          const toneProfile = await toneService.generateToneProfile(
            anthropic,
            tweets
          );

          // Update profile in database
          await supabase
            .from("operator_tones")
            .update({
              tone_json: toneProfile,
              last_learned_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("operator_id", profile.operator_id);

          console.log(
            `✅ [Cron] Successfully re-learned profile for ${profile.operator_id}`
          );
          successCount++;

          // Add a small delay to avoid rate limiting
          await new Promise((resolve) => setTimeout(resolve, 2000));
        } catch (profileError) {
          console.error(
            `❌ [Cron] Failed to re-learn profile for ${profile.operator_id}:`,
            profileError.message
          );
          failCount++;
        }
      }

      console.log(
        `\n✅ [Cron] Tone re-learning complete: ${successCount} success, ${failCount} failed\n`
      );
    } catch (error) {
      console.error(
        "❌ [Cron] Error in automatic tone re-learning:",
        error.message
      );
    }
  });

  console.log(
    "⏰ Automatic tone re-learning scheduler started (runs daily at 2 AM)"
  );
} else {
  console.log(
    "⚠️ Automatic tone re-learning disabled (Supabase or Anthropic not configured)"
  );
}

/**
 * Graceful shutdown
 */
process.on("SIGTERM", () => {
  console.log("\n🛑 Server shutting down...");
  process.exit(0);
});
