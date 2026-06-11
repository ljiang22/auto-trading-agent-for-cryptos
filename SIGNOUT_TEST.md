# Sign Out Confirmation Dialog - Test Case

## Overview
This test case validates the sign out confirmation dialog functionality that was added to prevent accidental user logouts.

## Test Environment
- **Client URL**: `http://localhost:5174`
- **Mock Authentication**: Available for local testing
- **Browser**: Any modern browser (Chrome, Firefox, Safari, Edge)

## Prerequisites
1. Start the local development server:
   ```bash
   pnpm start:client
   ```
2. Ensure the client is running on `http://localhost:5174`

## Test Scenario 1: Mock Authentication Login

### Steps
1. Open browser and navigate to `http://localhost:5174`
2. Click the "Sign In" button
3. Enter mock credentials:
   - **Email**: `test@test.com`
   - **Password**: `test`
4. Click "Sign In"

### Expected Results
- ✅ User should be successfully authenticated
- ✅ Header should display "Test User" name
- ✅ "Sign Out" button should be visible in the top-right corner
- ✅ Sign In/Sign Up buttons should be hidden

## Test Scenario 2: Sign Out Confirmation Dialog

### Steps
1. Ensure user is logged in (from Test Scenario 1)
2. Locate the "Sign Out" button in the header (top-right corner)
3. Click the "Sign Out" button

### Expected Results
- ✅ A modal dialog should appear
- ✅ Dialog title should read "Sign Out"
- ✅ Dialog message should read "Are you sure you want to sign out?"
- ✅ Two buttons should be present: "Cancel" and "Sign Out"
- ✅ Background should be dimmed/overlay visible

## Test Scenario 3: Cancel Sign Out

### Steps
1. Open the sign out confirmation dialog (from Test Scenario 2)
2. Click the "Cancel" button

### Expected Results
- ✅ Dialog should close immediately
- ✅ User should remain logged in
- ✅ Header should still show "Test User" name
- ✅ "Sign Out" button should still be available

## Test Scenario 4: Confirm Sign Out

### Steps
1. Open the sign out confirmation dialog
2. Click the "Sign Out" button (red/primary button)

### Expected Results
- ✅ Dialog should close
- ✅ User should be logged out
- ✅ Header should no longer show user name
- ✅ "Sign In" and "Sign Up" buttons should reappear
- ✅ User should be in unauthenticated state

## Test Scenario 5: Dialog Interaction Edge Cases

### Test 5a: Close with X Button
1. Open sign out confirmation dialog
2. Click the "X" button in top-right corner of dialog

**Expected Result**: Dialog closes, user remains logged in

### Test 5b: Close with Escape Key
1. Open sign out confirmation dialog
2. Press `Escape` key

**Expected Result**: Dialog closes, user remains logged in

### Test 5c: Click Outside Dialog
1. Open sign out confirmation dialog
2. Click on the dimmed background area outside the dialog

**Expected Result**: Dialog closes, user remains logged in

## Test Scenario 6: Keyboard Navigation

### Steps
1. Open sign out confirmation dialog
2. Use `Tab` key to navigate between buttons
3. Use `Enter` or `Space` to activate focused button

### Expected Results
- ✅ Tab navigation should work between "Cancel" and "Sign Out" buttons
- ✅ Focused button should have visible focus indicator
- ✅ Enter/Space should trigger the focused button's action

## Test Data

### Mock User Data
```json
{
  "id": "1",
  "email": "test@test.com",
  "first_name": "Test",
  "last_name": "User",
  "institution": "Test Corp",
  "job_title": "Developer"
}
```

## Component Files Modified
- `/client/src/components/Header.tsx` - Added dialog integration
- `/client/src/components/ui/dialog.tsx` - New dialog component
- `/client/src/contexts/AuthContext.tsx` - Added mock authentication

## Known Limitations
- Mock authentication only works in development mode
- Real API calls will still show CORS errors in console (expected)
- Dialog styling follows existing design system

## Success Criteria
All test scenarios should pass without errors. The sign out confirmation dialog should:
1. Prevent accidental logouts
2. Provide clear user feedback
3. Follow accessibility best practices
4. Maintain consistent UI/UX patterns

## Troubleshooting

### Issue: Cannot see "Sign Out" button
**Solution**: Ensure you're logged in with mock credentials (`test@test.com` / `test`)

### Issue: Dialog doesn't appear
**Solution**: Check browser console for JavaScript errors, ensure all dependencies are installed

### Issue: Mock login doesn't work
**Solution**: Verify the development server is running and `import.meta.env.DEV` is true