/**
 * Vector Operations Module
 * Handles vector storage, retrieval, and RAG queries
 */

/**
 * Store chunks with embeddings in Supabase
 * @param {object} supabase - Supabase client
 * @param {string} companyId - Company UUID
 * @param {string} documentId - Document UUID
 * @param {Array} chunks - Array of chunk objects with content, token_count, chunk_index
 * @param {Array} embeddings - Array of embedding vectors
 * @param {object} metadata - Additional metadata for chunks
 * @returns {Promise<number>} - Number of chunks stored
 */
async function storeChunks(supabase, companyId, documentId, chunks, embeddings, metadata = {}) {
  if (chunks.length !== embeddings.length) {
    throw new Error("Chunks and embeddings arrays must have the same length");
  }

  try {
    // Prepare chunk records
    const chunkRecords = chunks.map((chunk, index) => ({
      company_id: companyId,
      document_id: documentId,
      content: chunk.content,
      embedding: embeddings[index], // Supabase handles array -> vector conversion automatically
      chunk_index: chunk.chunk_index,
      token_count: chunk.token_count,
      metadata: { ...metadata, original_index: index },
    }));

    // Insert in batches to avoid payload size limits
    const batchSize = 50;
    let totalInserted = 0;

    for (let i = 0; i < chunkRecords.length; i += batchSize) {
      const batch = chunkRecords.slice(i, i + batchSize);
      
      const { data, error } = await supabase
        .from("company_chunks")
        .insert(batch);

      if (error) {
        throw error;
      }

      totalInserted += batch.length;
      console.log(`Stored batch ${Math.floor(i / batchSize) + 1}: ${batch.length} chunks`);
    }

    console.log(`✅ Stored ${totalInserted} chunks for document ${documentId}`);
    return totalInserted;
  } catch (error) {
    console.error("Error storing chunks:", error);
    throw new Error(`Failed to store chunks: ${error.message}`);
  }
}

/**
 * Retrieve relevant chunks for a query using vector similarity
 * @param {object} supabase - Supabase client
 * @param {string} companyId - Company UUID
 * @param {Array<number>} queryEmbedding - Query embedding vector
 * @param {number} limit - Maximum number of chunks to retrieve (default: 10)
 * @param {number} similarityThreshold - Minimum similarity score (default: 0.7)
 * @returns {Promise<Array>} - Array of relevant chunks with similarity scores
 */
async function retrieveRelevantChunks(
  supabase,
  companyId,
  queryEmbedding,
  limit = 10,
  similarityThreshold = 0.7
) {
  try {
    // Validate that companyId is a valid UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(companyId)) {
      throw new Error(`Invalid company ID format: ${companyId}. Must be a valid UUID. Did you visit the Knowledge page to create a company?`);
    }

    // Use the search_company_knowledge function we created in the migration
    const { data, error } = await supabase.rpc("search_company_knowledge", {
      p_company_id: companyId,
      p_query_embedding: queryEmbedding, // Pass as array, not JSON string
      p_limit: limit,
      p_similarity_threshold: similarityThreshold,
    });

    if (error) {
      throw error;
    }

    console.log(`✅ Retrieved ${data.length} relevant chunks for company ${companyId}`);
    return data;
  } catch (error) {
    console.error("Error retrieving chunks:", error);
    throw new Error(`Failed to retrieve chunks: ${error.message}`);
  }
}

/**
 * Get company knowledge statistics
 * @param {object} supabase - Supabase client
 * @param {string} companyId - Company UUID
 * @returns {Promise<object>} - Statistics object
 */
async function getCompanyStats(supabase, companyId) {
  try {
    const { data, error } = await supabase.rpc("get_company_knowledge_stats", {
      p_company_id: companyId,
    });

    if (error) {
      throw error;
    }

    // RPC returns array with single result
    const stats = data[0] || {
      total_documents: 0,
      total_chunks: 0,
      total_tokens: 0,
      total_storage_bytes: 0,
      last_updated: null,
    };

    return stats;
  } catch (error) {
    console.error("Error getting company stats:", error);
    throw new Error(`Failed to get company stats: ${error.message}`);
  }
}

/**
 * Delete all chunks for a document
 * @param {object} supabase - Supabase client
 * @param {string} documentId - Document UUID
 * @returns {Promise<void>}
 */
async function deleteDocumentChunks(supabase, documentId) {
  try {
    const { error } = await supabase
      .from("company_chunks")
      .delete()
      .eq("document_id", documentId);

    if (error) {
      throw error;
    }

    console.log(`✅ Deleted chunks for document ${documentId}`);
  } catch (error) {
    console.error("Error deleting chunks:", error);
    throw new Error(`Failed to delete chunks: ${error.message}`);
  }
}

/**
 * Format retrieved chunks for LLM context
 * @param {Array} chunks - Array of chunk objects from retrieval
 * @returns {string} - Formatted context string
 */
function formatChunksForContext(chunks) {
  if (!chunks || chunks.length === 0) {
    return "";
  }

  return chunks
    .map((chunk, index) => {
      return `[Source ${index + 1}: ${chunk.filename}]
${chunk.content}
---`;
    })
    .join("\n\n");
}

/**
 * Get company voice settings
 * @param {object} supabase - Supabase client
 * @param {string} companyId - Company UUID
 * @returns {Promise<object|null>} - Voice settings or null
 */
async function getCompanyVoiceSettings(supabase, companyId) {
  try {
    const { data, error } = await supabase
      .from("company_voice_settings")
      .select("*")
      .eq("company_id", companyId)
      .limit(1);

    if (error) {
      throw error;
    }

    return data && data.length > 0 ? data[0] : null;
  } catch (error) {
    console.error("Error getting voice settings:", error);
    return null;
  }
}

/**
 * Update or create company voice settings
 * @param {object} supabase - Supabase client
 * @param {string} companyId - Company UUID
 * @param {object} settings - Voice settings object
 * @returns {Promise<object>} - Updated settings
 */
async function upsertCompanyVoiceSettings(supabase, companyId, settings) {
  try {
    const { data, error } = await supabase
      .from("company_voice_settings")
      .upsert(
        {
          company_id: companyId,
          voice_guidelines: settings.voice_guidelines || null,
          brand_tone: settings.brand_tone || null,
          positioning: settings.positioning || null,
          metadata: settings.metadata || {},
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: "company_id",
        }
      )
      .select()
      .single();

    if (error) {
      throw error;
    }

    console.log(`✅ Updated voice settings for company ${companyId}`);
    return data;
  } catch (error) {
    console.error("Error upserting voice settings:", error);
    throw new Error(`Failed to update voice settings: ${error.message}`);
  }
}

/**
 * Format company voice settings for LLM prompt
 * @param {object} voiceSettings - Voice settings object
 * @returns {string} - Formatted voice settings
 */
function formatVoiceSettingsForPrompt(voiceSettings) {
  if (!voiceSettings) {
    return "";
  }

  const parts = [];

  if (voiceSettings.voice_guidelines) {
    parts.push(`Voice Guidelines: ${voiceSettings.voice_guidelines}`);
  }

  if (voiceSettings.brand_tone) {
    parts.push(`Brand Tone: ${voiceSettings.brand_tone}`);
  }

  if (voiceSettings.positioning) {
    parts.push(`Positioning: ${voiceSettings.positioning}`);
  }

  return parts.join("\n\n");
}

/**
 * Build RAG-enhanced context for reply generation
 * @param {object} options - Options object
 * @param {object} options.supabase - Supabase client
 * @param {object} options.openaiClient - OpenAI client
 * @param {string} options.companyId - Company UUID
 * @param {string} options.postText - Post text to generate reply for
 * @param {number} options.maxChunks - Maximum chunks to retrieve
 * @param {number} options.similarityThreshold - Similarity threshold
 * @returns {Promise<object>} - Context object with chunks and voice settings
 */
async function buildRagContext(options) {
  const {
    supabase,
    openaiClient,
    companyId,
    postText,
    maxChunks = 10,
    similarityThreshold = 0.7,
  } = options;

  try {
    // Generate embedding for the post text
    console.log("Generating embedding for post text...");
    const { generateEmbedding } = require("./documentProcessor");
    const queryEmbedding = await generateEmbedding(postText, openaiClient);

    // Retrieve relevant chunks
    console.log("Retrieving relevant chunks...");
    const chunks = await retrieveRelevantChunks(
      supabase,
      companyId,
      queryEmbedding,
      maxChunks,
      similarityThreshold
    );

    // Get voice settings
    console.log("Getting voice settings...");
    const voiceSettings = await getCompanyVoiceSettings(supabase, companyId);

    // Format context
    const formattedChunks = formatChunksForContext(chunks);
    const formattedVoice = formatVoiceSettingsForPrompt(voiceSettings);

    return {
      chunks: chunks,
      formattedChunks: formattedChunks,
      voiceSettings: voiceSettings,
      formattedVoice: formattedVoice,
      hasContext: chunks.length > 0 || voiceSettings !== null,
    };
  } catch (error) {
    console.error("Error building RAG context:", error);
    // Return empty context on error - don't break reply generation
    return {
      chunks: [],
      formattedChunks: "",
      voiceSettings: null,
      formattedVoice: "",
      hasContext: false,
    };
  }
}

module.exports = {
  storeChunks,
  retrieveRelevantChunks,
  getCompanyStats,
  deleteDocumentChunks,
  formatChunksForContext,
  getCompanyVoiceSettings,
  upsertCompanyVoiceSettings,
  formatVoiceSettingsForPrompt,
  buildRagContext,
};

