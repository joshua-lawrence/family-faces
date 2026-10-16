type ToolResult = { isError?: boolean; content?: Array<{ type: string; text?: string }> };
type CallTool = (name: string) => Promise<ToolResult>;

const textContent = (result: ToolResult) =>
  result.content?.filter(item => item.type === 'text').map(item => item.text || '').join('\n') || '';

export async function checkConnection(call: CallTool, connect = false) {
  if (connect) {
    const login = await call('login-with-browser');
    if (login.isError || !textContent(login).startsWith('Browser login complete.')) {
      return { status: 'disconnected', connected: false,
        note: 'FamilySearch sign-in did not finish. Sign in in Chrome, then click Connect FamilySearch to try again.' };
    }
  }
  const result = await call('get-current-user');
  const text = textContent(result);
  if (!result.isError && text.startsWith('Current user:')) {
    return { status: 'connected', connected: true, note: 'FamilySearch is connected. Check your selected photos and tags.' };
  }
  if (/HTTP 401|Not authenticated|invalid or expired|no FamilySearch access token/i.test(text)) {
    return { status: 'disconnected', connected: false,
      note: 'The saved FamilySearch session is not valid. Click Connect FamilySearch to sign in.' };
  }
  if (/security \(error 15\)|HTTP 403/.test(text)) {
    return { status: 'disconnected', connected: false,
      note: 'FamilySearch denied access. Click Connect FamilySearch to refresh the saved session.' };
  }
  return { status: 'error', connected: false,
    note: 'Could not check the FamilySearch connection. Check your network, then click Connect FamilySearch.' };
}
