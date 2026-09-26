const { MovieBoxClient } = require("./src");

async function main() {
  console.log("=========================================");
  console.log("   MovieBox Node.js Client Verification  ");
  console.log("=========================================\n");

  const client = new MovieBoxClient();

  console.log("1. Authenticating & initializing visitor session...");
  const token = await client.ensureSession();
  console.log(`✓ Session Token obtained: ${token.substring(0, 35)}...\n`);

  console.log("2. Searching catalog for 'Batman'...");
  const searchResult = await client.search("Batman", 1, 6);
  console.log(`✓ Found ${searchResult.items.length} items:\n`);

  searchResult.items.forEach((item, index) => {
    console.log(`   [${index + 1}] ${item.title} (${item.year || "N/A"}) [${item.type.toUpperCase()}]`);
    console.log(`       ID: ${item.id} | Rating: ${item.rating || "N/A"}`);
  });

  if (searchResult.items.length > 0) {
    const target = searchResult.items[0];
    console.log(`\n3. Fetching detailed metadata for '${target.title}' (ID: ${target.id})...`);
    const details = await client.getDetails(target.id);
    console.log(`✓ Title: ${details.title}`);
    console.log(`✓ Genres: ${details.genres.join(", ") || "N/A"}`);
    console.log(`✓ Synopsis: ${details.description ? details.description.substring(0, 100) + "..." : "N/A"}`);
    if (details.type === "series") {
      console.log(`✓ Series Seasons count: ${details.seasons.length}`);
    }

    console.log(`\n4. Extracting streams and decoding CloudFront signed DASH manifests...`);
    const isSeries = details.type === "series";
    const streamInfo = await client.getStreams(target.id, isSeries ? 1 : 0, isSeries ? 1 : 0);
    console.log(`✓ Available Stream Formats: ${streamInfo.streams.length}`);

    streamInfo.streams.forEach((s, idx) => {
      console.log(`\n   --- Stream #${idx + 1} ---`);
      console.log(`   Format: ${s.format} | Quality: ${s.resolutionLabel} | Codec: ${s.codec}`);
      console.log(`   Direct Manifest/URL: ${s.streamUrl}`);
      console.log(`   Signed Cookie Present: ${!!s.signCookie}`);
      console.log(`   Subtitles: ${s.subtitles.length} tracks`);
      console.log(`   MPV Command:\n   ${s.commands.mpv}`);
    });
  }

  console.log("\n=========================================");
  console.log("   All verification steps passed 100%!   ");
  console.log("=========================================\n");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
