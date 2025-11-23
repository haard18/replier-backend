/**
 * Twitter Service - Fetch and process tweets for tone analysis
 * Uses Twitter.io API to retrieve user's past tweets
 */

const axios = require('axios');

/**
 * Extract Twitter username from URL
 * Supports multiple URL formats:
 * - https://twitter.com/username
 * - https://x.com/username
 * - @username
 * - username
 */
function extractUsername(input) {
  if (!input || typeof input !== 'string') {
    throw new Error('Invalid Twitter URL or username');
  }

  const trimmed = input.trim();

  // Direct username
  if (!trimmed.includes('/') && !trimmed.includes('.')) {
    return trimmed.replace(/^@/, '');
  }

  // URL format
  const urlPatterns = [
    /(?:https?:\/\/)?(?:www\.)?twitter\.com\/([a-zA-Z0-9_]+)/,
    /(?:https?:\/\/)?(?:www\.)?x\.com\/([a-zA-Z0-9_]+)/,
  ];

  for (const pattern of urlPatterns) {
    const match = trimmed.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  // If no pattern matches, assume it's just a username
  return trimmed.replace(/^@/, '').split('/')[0].split('?')[0];
}

/**
 * Fetch tweets from Twitter.io API
 * Returns array of clean tweet texts (no retweets, no replies, no link-only posts)
 * API Documentation: https://docs.twitterapi.io/api-reference/endpoint/get_user_last_tweets
 * 
 * @param {string} username - Twitter username (without @)
 * @param {number} maxTweets - Maximum number of tweets to fetch (default: 150)
 * @returns {Promise<string[]>} Array of tweet texts
 */
async function fetchTweets(username, maxTweets = 150) {
  if (!username) {
    throw new Error('Username is required');
  }

  try {
    console.log(`🐦 Fetching tweets for @${username}...`);

    const allTweets = [];
    let cursor = '';
    let hasNextPage = true;
    let pagesLoaded = 0;
    const maxPages = Math.ceil(maxTweets / 20); // API returns up to 20 tweets per page

    // Paginate through tweets until we have enough or no more pages
    while (hasNextPage && allTweets.length < maxTweets && pagesLoaded < maxPages) {
      const params = {
        userName: username, // Use userName parameter (not userId)
        includeReplies: false, // Exclude replies
      };

      if (cursor) {
        params.cursor = cursor;
      }

      const response = await axios.get('https://api.twitterapi.io/twitter/user/last_tweets', {
        params,
        headers: {
          'X-API-Key': process.env.TWITTER_IO_API_KEY || '',
          'Accept': 'application/json',
        },
        timeout: 15000, // 15 second timeout
      });

      // Check response structure according to API docs
      if (!response.data || response.data.status !== 'success') {
        throw new Error(response.data?.message || 'Invalid response from Twitter API');
      }

      const { tweets, has_next_page, next_cursor } = response.data;

      if (!tweets || !Array.isArray(tweets)) {
        throw new Error('Invalid tweets data from Twitter API');
      }

      console.log(`📄 Loaded page ${pagesLoaded + 1}: ${tweets.length} tweets`);

      // Filter out retweets and replies, add to collection
      const filteredTweets = tweets.filter(tweet => {
        // Skip if it's a retweet (has retweeted_tweet field)
        if (tweet.retweeted_tweet) return false;
        
        // Skip if it's a reply (isReply is true)
        if (tweet.isReply) return false;
        
        return true;
      });

      allTweets.push(...filteredTweets);
      
      hasNextPage = has_next_page;
      cursor = next_cursor || '';
      pagesLoaded++;

      // Add small delay between requests to be respectful
      if (hasNextPage && allTweets.length < maxTweets) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    console.log(`✅ Fetched ${allTweets.length} original tweets from @${username}`);

    // Clean and filter tweets
    const cleanTweets = allTweets
      .map(tweet => tweet.text || '')
      .filter(text => {
        // Remove empty tweets
        if (!text.trim()) return false;

        // Remove tweets that are mostly URLs
        const urlCount = (text.match(/https?:\/\/\S+/g) || []).length;
        const wordCount = text.split(/\s+/).length;
        if (urlCount > 0 && wordCount < 5) return false;

        // Remove very short tweets (likely not representative)
        if (text.length < 20) return false;

        return true;
      })
      .map(text => {
        // Remove URLs for tone analysis
        return text.replace(/https?:\/\/\S+/g, '').trim();
      })
      .filter(text => text.length > 0);

    console.log(`✅ Cleaned to ${cleanTweets.length} usable tweets`);

    if (cleanTweets.length === 0) {
      throw new Error(`No usable tweets found for @${username}. User may have very few original posts.`);
    }

    // Return up to requested number
    return cleanTweets.slice(0, maxTweets);
  } catch (error) {
    console.error(`❌ Error fetching tweets for @${username}:`, error.message);

    // Handle specific error cases
    if (error.response) {
      if (error.response.status === 404) {
        throw new Error(`Twitter user @${username} not found`);
      }
      if (error.response.status === 429) {
        throw new Error('Twitter API rate limit reached. Please try again later.');
      }
      if (error.response.status === 401 || error.response.status === 403) {
        throw new Error('Twitter API authentication failed. Check TWITTER_IO_API_KEY in .env');
      }
      if (error.response.status === 400) {
        throw new Error(`Invalid request: ${error.response.data?.message || 'Bad request'}`);
      }
    }

    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      throw new Error('Twitter API request timed out. Please try again.');
    }

    throw new Error(`Failed to fetch tweets: ${error.message}`);
  }
}

/**
 * Mock function for testing without API calls
 * Returns sample tweets for development
 */
function fetchTweetsMock(username) {
  console.log(`🧪 [MOCK] Fetching tweets for @${username}...`);
  
  return Promise.resolve([
    "Just shipped a major feature at work. The dopamine hit from deploying on Friday is unmatched 🚀",
    "Hot take: The best code is code you don't have to write",
    "Why do we call it technical debt when it's really technical credit card with 40% APR",
    "Spent 3 hours debugging. The issue was a missing semicolon. I need a new career.",
    "Coffee is just hot water that thinks it's better than you",
    "The four stages of debugging: 1) That can't happen 2) That doesn't happen on my machine 3) That shouldn't happen 4) Why does that happen",
    "ProTip: If you write your code in TypeScript, JavaScript can't hurt you anymore. Mostly.",
    "Reading my code from 6 months ago is like reading a message from a past civilization",
    "Everyone's talking about AI replacing developers. Meanwhile, I can't get copilot to autocomplete a for loop correctly.",
    "The best part about working from home is you can rage at your code without anyone judging you",
    "Just discovered a bug in production that's been there for 2 years. Nobody noticed. Should I fix it or let sleeping bugs lie?",
    "Interviewer: Where do you see yourself in 5 years? Me: Not having to answer this question anymore",
    "My code works and I don't know why. Scarier than my code not working and me not knowing why.",
    "You can tell how desperate a company is by how many exclamation marks are in their job posting",
    "The tech industry is the only place where 'we move fast and break things' is considered a business strategy",
  ]);
}

module.exports = {
  extractUsername,
  fetchTweets,
  fetchTweetsMock,
};

