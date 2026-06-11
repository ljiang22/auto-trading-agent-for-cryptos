# Referral Links Guide

## Overview

The referral system allows you to track user registrations through unique referral codes. When users sign up through a referral link, their registration is automatically tagged with the referral code.

## How It Works

### 1. User Flow

1. **User clicks referral link** → `/signup?ref=CODE123`
2. **User enters email** → System sends registration email with referral code attached
3. **User opens registration link** → Referral code is auto-filled in the registration form
4. **User completes registration** → Referral code is saved to backend

### 2. Technical Flow

```
Referral Link (with ?ref=CODE)
        ↓
SignUpForm captures referral code
        ↓
POST /api/authentication/enrollment/token/
    { email: "user@example.com", referral_code: "CODE123" }
        ↓
Backend sends email with registration token
        ↓
GET /api/authentication/creation/{regToken}/
    Response: { referral_code: "CODE123", ... }
        ↓
RegistrationForm auto-fills referral code
        ↓
POST /api/authentication/creation/{regToken}/
    { ..., job_title: "CODE123", ... }
```

## Creating Referral Links

### Format

```
https://www.agent.sentiedge.ai/signup?ref={REFERRAL_CODE}
```


### Custom Referral Codes

You can create custom referral codes by changing the `ref` parameter:

```
https://www.agent.sentiedge.ai/signup?ref=YOUR_CUSTOM_CODE
```

**Best Practices:**
- Use alphanumeric characters (A-Z, 0-9)
- Keep it short and memorable (5-15 characters)
- Make it meaningful (e.g., campaign name, partner name)
- Avoid special characters except hyphens and underscores

## Testing

### Local Development

For local testing, use:
```
http://localhost:5173/signup?ref=TEST001
```

### Production

For production:
```
https://www.agent.sentiedge.ai/signup?ref=PROD001
```

## Tracking

The referral code is stored in the user's profile under the `job_title` field in the database. To track referrals:

1. Query the backend API for users with specific referral codes
2. Backend should provide analytics endpoints to track:
   - Number of signups per referral code
   - Conversion rates
   - User activity by referral source

## Backend Requirements

The backend API must support:

### 1. Token Creation Endpoint
`POST /api/authentication/enrollment/token/`

**Request:**
```json
{
  "email": "user@example.com",
  "referral_code": "PARTNER001"  // Optional
}
```

**Response:**
```json
{
  "message": "Registration email sent",
  "status": 201
}
```

### 2. Token Validation Endpoint
`GET /api/authentication/creation/{regToken}/`

**Response:**
```json
{
  "valid": true,
  "referral_code": "PARTNER001"  // If associated with the token
}
```

### 3. User Creation Endpoint
`POST /api/authentication/creation/{regToken}/`

**Request:**
```json
{
  "email": "user@example.com",
  "password": "********",
  "password2": "********",
  "job_title": "PARTNER001",  // Referral code stored here
  // ... other optional fields
}
```

## Notes

- Referral codes are **case-sensitive**
- The referral code field is **optional** - users can register without one
- Referral codes are stored in the `job_title` field (you may want to create a dedicated `referral_code` field in the future)
- Users can manually edit the referral code in the registration form if needed
