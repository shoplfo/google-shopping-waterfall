require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  apiSecretKey: process.env.API_SECRET_KEY,
  sessionSecret: process.env.SESSION_SECRET || process.env.API_SECRET_KEY,

  supabase: {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
    anonKey: process.env.SUPABASE_ANON_KEY,
    databaseUrl: process.env.DATABASE_URL,
  },

  googleAds: {
    developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    clientId: process.env.GOOGLE_ADS_CLIENT_ID,
    clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET,
    oauthCallbackUrl: process.env.OAUTH_CALLBACK_URL || 'http://localhost:3000/api/oauth/google/callback',
  },

  defaultDateRange: process.env.DEFAULT_DATE_RANGE || 'TODAY',
};
