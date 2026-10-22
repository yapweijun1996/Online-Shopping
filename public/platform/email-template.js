// Plain-text email a SuperAdmin can send to a shop's seller after creating or resetting the seller account.
// The seller must choose a new password at the first sign-in (the shop enforces it), so the mail says so.
export function sellerEmailTemplate({ shopName, sellerUrl, username, password }) {
  const subject = `Your ${shopName} seller account`;
  const body = [
    'Hello,',
    '',
    `Your seller account for ${shopName} is ready. Sign in with these details:`,
    '',
    `Seller page: ${sellerUrl}`,
    `Username: ${username}`,
    `Temporary password: ${password}`,
    '',
    'After you sign in you will be asked to choose a new password straight away. Please do this first: the temporary password',
    'stops working once you have set your own. Keep your new password private and do not share it with anyone.',
    '',
    'If you were not expecting this message, do not sign in and tell us.',
    '',
    'Thank you.',
  ].join('\n');
  return { subject, body, text: `Subject: ${subject}\n\n${body}` };
}
