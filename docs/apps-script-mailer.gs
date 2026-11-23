// Palmonas Command Center: email sender.
// Render's free plan blocks SMTP ports, so the app posts each email here over HTTPS, and this
// script sends it from the Google account that deploys it (for example mp@palmonas.com).
// Deploy: Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone.
// Put the web app URL in Render as GAS_URL. Keep that URL private.

function doPost(e) {
  try {
    var m = JSON.parse(e.postData.contents);
    if (!m.to || !m.subject || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m.to)) return out_({ ok: false, error: "bad request" });
    if (String(m.subject).indexOf("[Palmonas]") !== 0) return out_({ ok: false, error: "not a Palmonas email" });
    GmailApp.sendEmail(m.to, m.subject, m.text || "", { htmlBody: m.html || undefined, name: m.name || "Palmonas Command Center" });
    return out_({ ok: true, left: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    return out_({ ok: false, error: String(err) });
  }
}

function doGet() { return out_({ ok: true, service: "palmonas-mailer", left: MailApp.getRemainingDailyQuota() }); }

function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
