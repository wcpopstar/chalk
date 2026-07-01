function generateUsername() {
  const adjectives = ['Bright', 'Nova', 'Pixel', 'Swift', 'Cobalt', 'Echo', 'Mango', 'Rocket'];
  const nouns = ['Player', 'Ace', 'Quest', 'Byte', 'Rift', 'Spark', 'Orbit', 'Glide'];
  const number = Math.floor(100 + Math.random() * 900);
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adjective}${noun}${number}`;
}

module.exports = { generateUsername };
