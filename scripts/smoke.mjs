const url = process.env.CODEXMOBILE_URL || 'http://127.0.0.1:3321/api/status';

try {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || !data.connected) {
    console.error('Smoke failed:', response.status, data);
    process.exit(1);
  }
  console.log(`Smoke ok: ${data.hostName} ${data.provider}/${data.model} synced=${data.syncedAt}`);
} catch (error) {
  console.error(`Smoke failed: ${error.message}`);
  process.exit(1);
}

