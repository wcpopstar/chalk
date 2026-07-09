const { supabaseAdmin } = require('../services/supabase');

/**
 * Replaces a user's full game list (delete-then-insert, since the client
 * always sends the complete desired list rather than a diff).
 */
async function replaceForUser(userId: string, games: Array<{ game_id?: string; id?: string; rank?: string | null; hours_played?: number | null }>) {
  await supabaseAdmin.from('user_games').delete().eq('user_id', userId);
  if (games && games.length) {
    const rows = games.map((g) => ({
      user_id: userId,
      game_id: g.game_id,
      rank: g.rank || null,
      hours_played: g.hours_played || 0,
    }));
    const { error } = await supabaseAdmin.from('user_games').insert(rows);
    if (error) throw error;
  }
}

function findUserIdsByGame(gameId: string) {
  return supabaseAdmin.from('user_games').select('user_id').eq('game_id', gameId);
}

export { replaceForUser, findUserIdsByGame };
