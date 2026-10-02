async function getWeather(location = 'New York') {
  try {
    const response = await fetch(`https://wttr.in/${encodeURIComponent(location)}`, {
      headers: { 'User-Agent': 'curl' }
    });
    
    const text = await response.text();
    const cleanText = text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
    // Split into lines, take the first 8, and recombine them
    const firstEightLines = cleanText.split('\n').slice(0, 7).join('\n');
    
    return "```\n" + firstEightLines + "\n```";
  } catch (error) {
    console.error('Error:', error);
  }
}

module.exports = { getWeather };