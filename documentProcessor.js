/**
 * Document Processing Module
 * Handles file upload, text extraction, chunking, and embedding generation
 */

const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const axios = require("axios");
const cheerio = require("cheerio");

/**
 * Extract text from different file types
 * @param {Buffer} fileBuffer - The file buffer
 * @param {string} fileType - Type of file (pdf, docx, txt, md)
 * @returns {Promise<string>} - Extracted text content
 */
async function extractText(fileBuffer, fileType) {
  try {
    switch (fileType.toLowerCase()) {
      case "pdf":
        const pdfData = await pdfParse(fileBuffer);
        return pdfData.text;

      case "docx":
        const docxResult = await mammoth.extractRawText({ buffer: fileBuffer });
        return docxResult.value;

      case "txt":
      case "md":
        return fileBuffer.toString("utf-8");

      default:
        throw new Error(`Unsupported file type: ${fileType}`);
    }
  } catch (error) {
    console.error(`Error extracting text from ${fileType}:`, error);
    throw new Error(`Failed to extract text: ${error.message}`);
  }
}

/**
 * Scrape and extract text from a URL
 * @param {string} url - The URL to scrape
 * @returns {Promise<string>} - Extracted text content
 */
async function extractTextFromUrl(url) {
  try {
    const response = await axios.get(url, {
      timeout: 30000,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ReplyDash/1.0; +https://replydash.com)",
      },
    });

    const html = response.data;
    const $ = cheerio.load(html);

    // Remove script, style, and other non-content elements
    $("script, style, nav, header, footer, iframe, noscript").remove();

    // Extract text from main content areas
    let text = "";
    
    // Try to find main content area
    const mainContent = $("main, article, .content, .post, #content").first();
    if (mainContent.length > 0) {
      text = mainContent.text();
    } else {
      // Fallback to body
      text = $("body").text();
    }

    // Clean up whitespace
    text = text
      .replace(/\s+/g, " ")
      .replace(/\n+/g, "\n")
      .trim();

    if (!text || text.length < 100) {
      throw new Error("Insufficient content extracted from URL");
    }

    return text;
  } catch (error) {
    console.error(`Error extracting text from URL ${url}:`, error);
    throw new Error(`Failed to extract text from URL: ${error.message}`);
  }
}

/**
 * Clean extracted text
 * @param {string} text - Raw text
 * @returns {string} - Cleaned text
 */
function cleanText(text) {
  return text
    // Remove excessive whitespace
    .replace(/\s+/g, " ")
    // Remove excessive newlines
    .replace(/\n{3,}/g, "\n\n")
    // Remove control characters
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "")
    // Trim
    .trim();
}

/**
 * Estimate token count (rough approximation: 1 token ≈ 4 characters)
 * @param {string} text - Text to estimate
 * @returns {number} - Estimated token count
 */
function estimateTokenCount(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Chunk text into smaller pieces suitable for embedding
 * Uses sliding window approach with overlap for better context
 * @param {string} text - Text to chunk
 * @param {number} chunkSize - Target chunk size in tokens (default: 500)
 * @param {number} overlap - Overlap between chunks in tokens (default: 100)
 * @returns {Array<{content: string, token_count: number, chunk_index: number}>}
 */
function chunkText(text, chunkSize = 500, overlap = 100) {
  const chunks = [];
  
  // Convert token size to character count (rough estimate: 1 token ≈ 4 chars)
  const chunkCharSize = chunkSize * 4;
  const overlapCharSize = overlap * 4;
  
  // Split by paragraphs first to maintain semantic boundaries
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0);
  
  let currentChunk = "";
  let chunkIndex = 0;
  
  for (const paragraph of paragraphs) {
    const paragraphLength = paragraph.length;
    
    // If current chunk + paragraph exceeds chunk size
    if (currentChunk.length + paragraphLength > chunkCharSize && currentChunk.length > 0) {
      // Save current chunk
      chunks.push({
        content: currentChunk.trim(),
        token_count: estimateTokenCount(currentChunk),
        chunk_index: chunkIndex,
      });
      chunkIndex++;
      
      // Start new chunk with overlap
      const overlapText = currentChunk.slice(-overlapCharSize);
      currentChunk = overlapText + " " + paragraph;
    } else {
      // Add to current chunk
      currentChunk += (currentChunk ? "\n\n" : "") + paragraph;
    }
  }
  
  // Add final chunk if not empty
  if (currentChunk.trim().length > 0) {
    chunks.push({
      content: currentChunk.trim(),
      token_count: estimateTokenCount(currentChunk),
      chunk_index: chunkIndex,
    });
  }
  
  // If no chunks were created (text too short), create a single chunk
  if (chunks.length === 0 && text.trim().length > 0) {
    chunks.push({
      content: text.trim(),
      token_count: estimateTokenCount(text),
      chunk_index: 0,
    });
  }
  
  return chunks;
}

/**
 * Generate embeddings for text chunks using OpenAI
 * @param {string} text - Text to embed
 * @param {object} openaiClient - OpenAI client instance
 * @returns {Promise<Array<number>>} - Embedding vector
 */
async function generateEmbedding(text, openaiClient) {
  try {
    const response = await openaiClient.embeddings.create({
      model: "text-embedding-3-small", // 1536 dimensions
      input: text,
    });

    return response.data[0].embedding;
  } catch (error) {
    console.error("Error generating embedding:", error);
    throw new Error(`Failed to generate embedding: ${error.message}`);
  }
}

/**
 * Generate embeddings for multiple text chunks in batch
 * @param {Array<string>} texts - Array of texts to embed
 * @param {object} openaiClient - OpenAI client instance
 * @returns {Promise<Array<Array<number>>>} - Array of embedding vectors
 */
async function generateEmbeddingsBatch(texts, openaiClient) {
  try {
    // OpenAI allows batch requests for embeddings
    const response = await openaiClient.embeddings.create({
      model: "text-embedding-3-small",
      input: texts,
    });

    return response.data.map(item => item.embedding);
  } catch (error) {
    console.error("Error generating batch embeddings:", error);
    throw new Error(`Failed to generate batch embeddings: ${error.message}`);
  }
}

/**
 * Process a document: extract, clean, chunk, and prepare for embedding
 * @param {Buffer} fileBuffer - File buffer
 * @param {string} fileType - File type
 * @param {object} options - Processing options
 * @returns {Promise<{text: string, chunks: Array}>}
 */
async function processDocument(fileBuffer, fileType, options = {}) {
  const {
    chunkSize = 500,
    overlap = 100,
  } = options;

  try {
    // Extract text
    console.log(`Extracting text from ${fileType}...`);
    const rawText = await extractText(fileBuffer, fileType);

    // Clean text
    console.log("Cleaning text...");
    const cleanedText = cleanText(rawText);

    if (cleanedText.length < 50) {
      throw new Error("Document too short or empty after cleaning");
    }

    // Chunk text
    console.log("Chunking text...");
    const chunks = chunkText(cleanedText, chunkSize, overlap);

    console.log(`Processed document: ${cleanedText.length} chars, ${chunks.length} chunks`);

    return {
      text: cleanedText,
      chunks: chunks,
      totalTokens: chunks.reduce((sum, chunk) => sum + chunk.token_count, 0),
    };
  } catch (error) {
    console.error("Error processing document:", error);
    throw error;
  }
}

/**
 * Process a URL: scrape, extract, clean, chunk, and prepare for embedding
 * @param {string} url - URL to process
 * @param {object} options - Processing options
 * @returns {Promise<{text: string, chunks: Array}>}
 */
async function processUrl(url, options = {}) {
  const {
    chunkSize = 500,
    overlap = 100,
  } = options;

  try {
    // Extract text from URL
    console.log(`Extracting text from URL: ${url}...`);
    const rawText = await extractTextFromUrl(url);

    // Clean text
    console.log("Cleaning text...");
    const cleanedText = cleanText(rawText);

    if (cleanedText.length < 50) {
      throw new Error("URL content too short or empty after cleaning");
    }

    // Chunk text
    console.log("Chunking text...");
    const chunks = chunkText(cleanedText, chunkSize, overlap);

    console.log(`Processed URL: ${cleanedText.length} chars, ${chunks.length} chunks`);

    return {
      text: cleanedText,
      chunks: chunks,
      totalTokens: chunks.reduce((sum, chunk) => sum + chunk.token_count, 0),
    };
  } catch (error) {
    console.error("Error processing URL:", error);
    throw error;
  }
}

module.exports = {
  extractText,
  extractTextFromUrl,
  cleanText,
  estimateTokenCount,
  chunkText,
  generateEmbedding,
  generateEmbeddingsBatch,
  processDocument,
  processUrl,
};

