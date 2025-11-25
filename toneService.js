/**
 * Tone Extraction Service
 * Uses Claude LLM to analyze tweets and generate operator tone profiles
 */

/**
 * System prompt for tone extraction
 */
const TONE_EXTRACTION_PROMPT = `You are a writing style analyst. Analyze the provided tweets and extract the author's writing style and tone characteristics.

Your job is to create a concise, actionable tone profile that can be used to replicate this person's writing style.

Output ONLY valid JSON with this exact structure (no markdown, no prose, no extra text):

{
  "tone_keywords": ["keyword1", "keyword2", "keyword3"],
  "style_description": "One sentence describing overall style",
  "sentence_patterns": "Brief description of sentence structure preferences",
  "vocabulary_profile": "Description of word choice and language level",
  "common_phrases": ["phrase1", "phrase2", "phrase3"],
  "formality_level": "low | medium | high",
  "humor_style": "Brief description or 'none'",
  "quirks": "Notable stylistic quirks or 'none'",
  "tone_rules": [
    "Specific instruction 1",
    "Specific instruction 2",
    "Specific instruction 3"
  ]
}

Be specific and actionable. Focus on patterns that can be replicated.`;

/**
 * Generate tone profile from tweets using Claude
 * 
 * @param {Object} anthropicClient - Initialized Anthropic client
 * @param {string[]} tweets - Array of tweet texts
 * @returns {Promise<Object>} Tone profile JSON
 */
async function generateToneProfile(anthropicClient, tweets) {
  if (!anthropicClient) {
    throw new Error('Anthropic client not initialized');
  }

  if (!tweets || tweets.length === 0) {
    throw new Error('No tweets provided for tone analysis');
  }

  try {
    console.log(`🧠 Analyzing ${tweets.length} tweets for tone profile...`);

    // Prepare tweets for analysis (sample if too many)
    const sampleSize = Math.min(tweets.length, 100);
    const sampleTweets = tweets.slice(0, sampleSize);

    // Format tweets for prompt
    const tweetsText = sampleTweets
      .map((tweet, i) => `${i + 1}. "${tweet}"`)
      .join('\n');

    const userPrompt = `Analyze these tweets and extract the writing style:

TWEETS:
${tweetsText}

Remember: Output ONLY the JSON object, nothing else.`;

    // Call Claude
    const message = await anthropicClient.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1500,
      temperature: 0.3, // Lower temperature for more consistent analysis
      system: TONE_EXTRACTION_PROMPT,
      messages: [
        {
          role: 'user',
          content: userPrompt,
        },
      ],
    });

    // Extract response
    if (!message || !message.content || message.content.length === 0) {
      throw new Error('Empty response from Claude');
    }

    const responseText = message.content[0].text;

    // Parse JSON
    let toneProfile;
    try {
      // Try to extract JSON from response (in case Claude wrapped it in markdown)
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      const jsonText = jsonMatch ? jsonMatch[0] : responseText;
      toneProfile = JSON.parse(jsonText);
    } catch (parseError) {
      console.error('❌ Failed to parse tone profile JSON:', responseText);
      throw new Error('Invalid JSON response from tone analysis');
    }

    // Validate structure
    const requiredFields = [
      'tone_keywords',
      'style_description',
      'sentence_patterns',
      'vocabulary_profile',
      'formality_level',
      'tone_rules',
    ];

    for (const field of requiredFields) {
      if (!toneProfile[field]) {
        throw new Error(`Missing required field in tone profile: ${field}`);
      }
    }

    console.log('✅ Tone profile generated successfully');
    console.log(`   - Formality: ${toneProfile.formality_level}`);
    console.log(`   - Keywords: ${toneProfile.tone_keywords.join(', ')}`);

    return toneProfile;
  } catch (error) {
    console.error('❌ Error generating tone profile:', error.message);
    throw error;
  }
}

/**
 * Format tone profile for use in reply generation prompts
 * Converts JSON structure into natural language description
 * 
 * @param {Object} toneJson - Tone profile JSON
 * @returns {string} Formatted tone description
 */
function formatToneForPrompt(toneJson) {
  if (!toneJson) {
    return '';
  }

  let formatted = '### Operator Writing Style:\n\n';

  if (toneJson.style_description) {
    formatted += `**Overall Style:** ${toneJson.style_description}\n\n`;
  }

  if (toneJson.formality_level) {
    formatted += `**Formality Level:** ${toneJson.formality_level}\n\n`;
  }

  if (toneJson.tone_keywords && toneJson.tone_keywords.length > 0) {
    formatted += `**Tone Keywords:** ${toneJson.tone_keywords.join(', ')}\n\n`;
  }

  if (toneJson.sentence_patterns) {
    formatted += `**Sentence Patterns:** ${toneJson.sentence_patterns}\n\n`;
  }

  if (toneJson.vocabulary_profile) {
    formatted += `**Vocabulary:** ${toneJson.vocabulary_profile}\n\n`;
  }

  if (toneJson.humor_style && toneJson.humor_style !== 'none') {
    formatted += `**Humor Style:** ${toneJson.humor_style}\n\n`;
  }

  if (toneJson.quirks && toneJson.quirks !== 'none') {
    formatted += `**Quirks:** ${toneJson.quirks}\n\n`;
  }

  if (toneJson.common_phrases && toneJson.common_phrases.length > 0) {
    formatted += `**Common Phrases:** ${toneJson.common_phrases.join(', ')}\n\n`;
  }

  if (toneJson.tone_rules && toneJson.tone_rules.length > 0) {
    formatted += '**Style Rules:**\n';
    toneJson.tone_rules.forEach((rule, i) => {
      formatted += `${i + 1}. ${rule}\n`;
    });
  }

  return formatted;
}

/**
 * Create a fallback tone profile when no valid tweets are available
 * 
 * @returns {Object} Default tone profile
 */
function getDefaultToneProfile() {
  return {
    tone_keywords: ['professional', 'clear', 'concise'],
    style_description: 'Professional and straightforward communication style',
    sentence_patterns: 'Clear, direct sentences with good flow',
    vocabulary_profile: 'Professional vocabulary with accessible language',
    common_phrases: [],
    formality_level: 'medium',
    humor_style: 'subtle when appropriate',
    quirks: 'none',
    tone_rules: [
      'Keep responses professional and clear',
      'Use proper grammar and punctuation',
      'Be concise and to the point',
    ],
  };
}

module.exports = {
  generateToneProfile,
  formatToneForPrompt,
  getDefaultToneProfile,
};


