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
 * Request body: { text: "original post text" }
 * Response: plain text reply (Web3 thought leader tone)
 */
app.post("/generate/linkedin", async (req, res) => {
  try {
    const { text } = req.body;

    // Validate input
    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return res.status(400).json({
        error: "Invalid input. Please provide a 'text' field with post content.",
      });
    }

    console.log(`📝 [LinkedIn] Generating reply for: "${text.substring(0, 50)}..."`);

    // Double-check Anthropic client exists
    if (!anthropic) {
      throw new Error("Anthropic client not initialized. Check your API key.");
    }

    // Call Anthropic Claude API to generate a LinkedIn reply
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-5", // Claude Sonnet 4.5
      max_tokens: 150,
      system: `## Role: Web3 Thought Leader for LinkedIn Comments
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

**Output:** Provide **only the final LinkedIn comment**, written naturally as a Web3 professional. No labels or formatting — just the comment.`,
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

    // Return the reply as plain text
    res.set("Content-Type", "text/plain");
    res.send(reply);
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
 * Request body: { text: "original post text" }
 * Response: plain text reply (quirky and fun tone, shorter)
 */
app.post("/generate/twitter", async (req, res) => {
  try {
    const { text } = req.body;

    // Validate input
    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return res.status(400).json({
        error: "Invalid input. Please provide a 'text' field with post content.",
      });
    }

    console.log(`📝 [Twitter] Generating reply for: "${text.substring(0, 50)}..."`);

    // Double-check Anthropic client exists
    if (!anthropic) {
      throw new Error("Anthropic client not initialized. Check your API key.");
    }

    // Call Anthropic Claude API to generate a Twitter reply
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-5", // Claude Sonnet 3.5
      max_tokens: 100, // Shorter for Twitter
      system: `## Role: Quirky Web3 Personality for Twitter
You are a **fun, witty, and quirky Web3 personality** on Twitter. Your replies are:
* Short, punchy, and entertaining (1-2 sentences max)
* Smart but casual — not trying too hard
* Occasionally use clever wordplay or light humor related to crypto/tech
* Include relevant emojis (but don't overdo it)
* End with something that sparks conversation
* No jargon-heavy corporate talk
* Be authentic, slightly irreverent, but respectful

**Tone Examples:** "haha love this energy 🔥" "this is the way ⛓️" "based take" "brb telling everyone" "ok but why though 👀"

**Output:** Provide **only the tweet reply**, written naturally and conversationally. No explanations or labels — just the reply.`,
      messages: [
        {
          role: "user",
          content: `Generate a fun, quirky Twitter reply to this post:

"${text}"

Remember: Keep it short (1-2 sentences), witty, and use appropriate emojis. Only provide the reply itself, nothing else.`,
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

    // Return the reply as plain text
    res.set("Content-Type", "text/plain");
    res.send(reply);
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
 * Legacy endpoint - auto-detects platform based on referer or defaults to LinkedIn
 * POST /generate
 */
app.post("/generate", async (req, res) => {
  const referer = req.get("referer") || "";
  const platform = referer.includes("x.com") || referer.includes("twitter.com") ? "twitter" : "linkedin";
  
  // Forward to appropriate endpoint
  if (platform === "twitter") {
    // Create a mock request and pass to Twitter handler
    const originalUrl = req.url;
    req.url = "/generate/twitter";
    app._router.handle(req, res);
  } else {
    const originalUrl = req.url;
    req.url = "/generate/linkedin";
    app._router.handle(req, res);
  }
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
