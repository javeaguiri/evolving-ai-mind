import { ConfidentialClientApplication } from '@azure/msal-node';

const msalConfig = {
  auth: {
    clientId: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    authority: `https://login.microsoftonline.com/${process.env.TENANT_ID}`,
  },
  system: {
    loggerOptions: {
      loggerCallback: (level, message, containsPii) => {
        if (containsPii) return;
        if (level === 0) console.error(message); // Error
      },
      piiLoggingEnabled: false,
      logLevel: 3, // Warning
    },
  },
};

const cca = new ConfidentialClientApplication(msalConfig);

export async function getAccessToken() {
  try {
    const tokenRequest = {
      scopes: ['https://graph.microsoft.com/.default'], // All app permissions
    };

    const response = await cca.acquireTokenByClientCredential(tokenRequest);
    
    if (!response || !response.accessToken) {
      throw new Error('No access token received');
    }

    console.log('MSAL token acquired successfully');
    return response.accessToken;
  } catch (error) {
    console.error('MSAL token acquisition failed:', error);
    throw error;
  }
}
