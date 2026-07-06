"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { supabaseAdmin } = require('../services/supabase');
/**
 * Replaces a user's full game list (delete-then-insert, since the client
 * always sends the complete desired list rather than a diff).
 */
async function replaceForUser(userId, games) {
    await supabaseAdmin.from('user_games').delete().eq('user_id', userId);
    if (games && games.length) {
        const rows = games.map((g) => ({
            user_id: userId,
            game_id: g.game_id,
            rank: g.rank || null,
            hours_played: g.hours_played || 0,
        }));
        const { error } = await supabaseAdmin.from('user_games').insert(rows);
        if (error)
            throw error;
    }
}
function findUserIdsByGame(gameId) {
    return supabaseAdmin.from('user_games').select('user_id').eq('game_id', gameId);
}
module.exports = { replaceForUser, findUserIdsByGame };
//# sourceMappingURL=userGamesRepository.js.map