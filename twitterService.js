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

  // Check for API key
  if (!process.env.TWITTER_IO_API_KEY) {
    console.warn('⚠️ TWITTER_IO_API_KEY not found in environment variables');
    console.warn('💡 Get your API key from https://twitterapi.io/');
    throw new Error('TWITTER_IO_API_KEY is required. Sign up at https://twitterapi.io/ to get your API key.');
  }

  try {
    console.log(`🐦 Fetching tweets for @${username}...`);
    console.log(`🔑 Using API key: ${process.env.TWITTER_IO_API_KEY.substring(0, 8)}...`);

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

      // Log response for debugging
      console.log(`📡 API Response status: ${response.data?.status}`);

      // Check response structure according to API docs
      if (!response.data) {
        throw new Error('Empty response from Twitter API');
      }

      if (response.data.status === 'error') {
        throw new Error(response.data.msg || response.data.message || 'Twitter API returned an error');
      }

      if (response.data.status !== 'success') {
        console.warn('⚠️ Unexpected API status:', response.data.status);
      }

      // The actual response structure is: { status, code, msg, data: { tweets, pin_tweet } }
      const responseData = response.data.data || response.data;
      const tweets = responseData.tweets;
      
      // Note: Twitter.io API doesn't return has_next_page/next_cursor in the same way
      // It's inside the data object or not present at all
      const has_next_page = responseData.has_next_page !== undefined 
        ? responseData.has_next_page 
        : tweets && tweets.length === 20; // Assume more if we got 20
      const next_cursor = responseData.next_cursor || '';

      if (!tweets) {
        console.error('❌ No tweets field in response:', JSON.stringify(response.data, null, 2));
        throw new Error('No tweets data in API response. Check API key and rate limits.');
      }

      if (!Array.isArray(tweets)) {
        console.error('❌ Tweets is not an array:', typeof tweets);
        throw new Error('Invalid tweets data structure from Twitter API');
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

/**
 * Fetch replies for a tweet using Twitter.io API
 * @param {string} tweetId - Original tweet ID
 * @param {number} maxReplies - Maximum number of replies to return
 * @returns {Promise<Array>} Array of reply metadata objects
 */
async function fetchTweetReplies(tweetId, maxReplies = 10) {
  if (!tweetId) {
    throw new Error('tweetId is required to fetch replies');
  }

  if (!process.env.TWITTER_IO_API_KEY) {
    throw new Error('TWITTER_IO_API_KEY is required. Set it in your environment to enable reply fetching.');
  }

  try {
    console.log(`💬 Fetching up to ${maxReplies} replies for tweet ${tweetId}`);

    const collectedReplies = [];
    let cursor = '';
    let hasNextPage = true;
    let pageCount = 0;
    const maxPages = Math.max(1, Math.ceil(maxReplies / 20));

    while (hasNextPage && collectedReplies.length < maxReplies && pageCount < maxPages) {
      const params = { tweetId };
      if (cursor) {
        params.cursor = cursor;
      }

      const response = await axios.get('https://api.twitterapi.io/twitter/tweet/replies', {
        params,
        headers: {
          'X-API-Key': process.env.TWITTER_IO_API_KEY || '',
          'Accept': 'application/json',
        },
        timeout: 15000,
      });

      const rawData = response.data || {};
      if (rawData.status === 'error') {
        throw new Error(rawData.message || 'Twitter API returned an error while fetching replies');
      }

      const payload = rawData.replies ? rawData : rawData.data || {};
      const replies = payload.replies;
      if (!Array.isArray(replies)) {
        console.warn('⚠️ Unexpected replies structure from Twitter API:', JSON.stringify(rawData).substring(0, 200));
        break;
      }

      console.log(`📨 Loaded ${replies.length} replies (page ${pageCount + 1})`);

      for (const reply of replies) {
        if (!reply?.text) continue;
        collectedReplies.push({
          id: reply.id,
          text: reply.text.trim(),
          inReplyToId: reply.inReplyToId || reply.in_reply_to_status_id,
          authorName: reply.author?.name || '',
          authorUsername: reply.author?.userName || reply.author?.username || '',
          likeCount: reply.likeCount ?? reply.favoriteCount ?? 0,
          replyCount: reply.replyCount ?? 0,
          createdAt: reply.createdAt || reply.created_at,
        });
        if (collectedReplies.length >= maxReplies) {
          break;
        }
      }

      const nextCursor = payload.next_cursor || '';
      hasNextPage = Boolean(payload.has_next_page && nextCursor);
      cursor = nextCursor;
      pageCount++;

      if (hasNextPage && collectedReplies.length < maxReplies) {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }

    console.log(`✅ Retrieved ${collectedReplies.length} replies for tweet ${tweetId}`);
    return collectedReplies.slice(0, maxReplies);
  } catch (error) {
    console.error(`❌ Error fetching replies for tweet ${tweetId}:`, error.message);

    if (error.response) {
      if (error.response.status === 404) {
        throw new Error(`Tweet ${tweetId} not found or deleted`);
      }
      if (error.response.status === 429) {
        throw new Error('Twitter API rate limit reached while fetching replies. Please try again later.');
      }
      if (error.response.status === 401 || error.response.status === 403) {
        throw new Error('Twitter API authentication failed when fetching replies. Check TWITTER_IO_API_KEY.');
      }
      if (error.response.status === 400) {
        throw new Error(`Invalid reply request: ${error.response.data?.message || 'Bad request'}`);
      }
    }

    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      throw new Error('Twitter API request for replies timed out. Please try again.');
    }

    throw new Error(`Failed to fetch tweet replies: ${error.message}`);
  }
}

module.exports = {
  extractUsername,
  fetchTweets,
  fetchTweetsMock,
  fetchTweetReplies,
};

