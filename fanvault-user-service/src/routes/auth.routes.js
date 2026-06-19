const { Router } = require('express');
const {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  SignUpCommand,
  GlobalSignOutCommand,
} = require('@aws-sdk/client-cognito-identity-provider');
const jwt = require('jsonwebtoken');

const router = Router();

const cognitoClient = new CognitoIdentityProviderClient({
  region: process.env.COGNITO_REGION || 'us-east-1',
});

const CLIENT_ID = process.env.COGNITO_CLIENT_ID;

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'email and password required' });
  try {
    const { AuthenticationResult } = await cognitoClient.send(
      new InitiateAuthCommand({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: CLIENT_ID,
        AuthParameters: { USERNAME: email, PASSWORD: password },
      })
    );
    res.json({
      accessToken:  AuthenticationResult.AccessToken,
      idToken:      AuthenticationResult.IdToken,
      refreshToken: AuthenticationResult.RefreshToken,
      expiresIn:    AuthenticationResult.ExpiresIn,
    });
  } catch (err) {
    const status = err.name === 'NotAuthorizedException' ? 401 : 400;
    res.status(status).json({ error: err.message });
  }
});

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { email, password, firstName, lastName } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'email and password required' });
  try {
    await cognitoClient.send(
      new SignUpCommand({
        ClientId: CLIENT_ID,
        Username: email,
        Password: password,
        UserAttributes: [
          { Name: 'email', Value: email },
          ...(firstName ? [{ Name: 'given_name',  Value: firstName }] : []),
          ...(lastName  ? [{ Name: 'family_name', Value: lastName  }] : []),
        ],
      })
    );
    res.status(201).json({ message: 'Registration successful. Please verify your email.' });
  } catch (err) {
    const status = err.name === 'UsernameExistsException' ? 409 : 400;
    res.status(status).json({ error: err.message });
  }
});

// GET /api/auth/verify — local JWT decode, no Cognito round-trip
router.get('/verify', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer '))
    return res.status(401).json({ error: 'Token required' });
  const decoded = jwt.decode(authHeader.split(' ')[1]);
  if (!decoded) return res.status(401).json({ error: 'Invalid token' });
  res.json({
    id:     decoded.sub,
    email:  decoded.email,
    groups: decoded['cognito:groups'] || [],
  });
});

// POST /api/auth/logout — GlobalSignOut invalidates all sessions for the user in Cognito
router.post('/logout', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer '))
    return res.status(401).json({ error: 'Token required' });
  try {
    await cognitoClient.send(
      new GlobalSignOutCommand({ AccessToken: authHeader.split(' ')[1] })
    );
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken)
    return res.status(400).json({ error: 'refreshToken required' });
  try {
    const { AuthenticationResult } = await cognitoClient.send(
      new InitiateAuthCommand({
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: CLIENT_ID,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      })
    );
    res.json({
      accessToken: AuthenticationResult.AccessToken,
      idToken:     AuthenticationResult.IdToken,
      expiresIn:   AuthenticationResult.ExpiresIn,
    });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

module.exports = router;
