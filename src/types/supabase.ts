// ── Supabase Database schema type ───────────────────────────────────────────
// Hand-derived from supabase/migrations/*.sql (001–013) in the same shape
// `supabase gen types typescript` produces, so the two are drop-in
// interchangeable: when this schema next changes, either update the table
// here alongside the migration, or run the official generator against the
// live project and replace this file wholesale.
//
// Why hand-derived: the generator needs either a linked Supabase project
// (access token) or a locally running stack (Docker); the migrations folder
// is the same source of truth those would read, just parsed by a human.
//
// Relationships use PostgreSQL's default constraint naming
// (`{table}_{column}_fkey`) — the migrations never name constraints
// explicitly, and the query code already relies on these exact names in
// disambiguation hints (e.g. `users!match_history_user_a_fkey`).

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type MessageType = 'text' | 'voice' | 'gif' | 'video_note' | 'youtube' | 'image' | 'video' | 'file';

export interface Database {
  public: {
    Tables: {
      games: {
        Row: {
          id: string;
          name: string;
          emoji: string;
          active: boolean;
        };
        Insert: {
          id: string;
          name: string;
          emoji?: string;
          active?: boolean;
        };
        Update: {
          id?: string;
          name?: string;
          emoji?: string;
          active?: boolean;
        };
        Relationships: [];
      };

      users: {
        Row: {
          id: string;
          username: string;
          email: string;
          password_hash: string;
          avatar_emoji: string;
          bio: string | null;
          country: string | null;
          languages: string[];
          status: string;
          avg_rating: number | null;
          last_seen: string | null;
          created_at: string;
          age: number | null;
          gender: string | null;
          avatar_url: string | null;
          onboarding_completed: boolean;
          presence: string;
          status_text: string | null;
          email_verified: boolean;
          total_call_seconds: number;
          total_calls: number;
          public_key: string | null;
          e2ee_backup_secret: string | null;
          e2ee_backup_nonce: string | null;
          e2ee_backup_salt: string | null;
          e2ee_backup_iters: number | null;
          banned_until: string | null;
          ban_reason: string | null;
        };
        Insert: {
          id?: string;
          username: string;
          email: string;
          password_hash: string;
          avatar_emoji?: string;
          bio?: string | null;
          country?: string | null;
          languages?: string[];
          status?: string;
          avg_rating?: number | null;
          last_seen?: string | null;
          created_at?: string;
          age?: number | null;
          gender?: string | null;
          avatar_url?: string | null;
          onboarding_completed?: boolean;
          presence?: string;
          status_text?: string | null;
          email_verified?: boolean;
          total_call_seconds?: number;
          total_calls?: number;
          public_key?: string | null;
          e2ee_backup_secret?: string | null;
          e2ee_backup_nonce?: string | null;
          e2ee_backup_salt?: string | null;
          e2ee_backup_iters?: number | null;
          banned_until?: string | null;
          ban_reason?: string | null;
        };
        Update: {
          id?: string;
          username?: string;
          email?: string;
          password_hash?: string;
          avatar_emoji?: string;
          bio?: string | null;
          country?: string | null;
          languages?: string[];
          status?: string;
          avg_rating?: number | null;
          last_seen?: string | null;
          created_at?: string;
          age?: number | null;
          gender?: string | null;
          avatar_url?: string | null;
          onboarding_completed?: boolean;
          presence?: string;
          status_text?: string | null;
          email_verified?: boolean;
          total_call_seconds?: number;
          total_calls?: number;
          public_key?: string | null;
          e2ee_backup_secret?: string | null;
          e2ee_backup_nonce?: string | null;
          e2ee_backup_salt?: string | null;
          e2ee_backup_iters?: number | null;
          banned_until?: string | null;
          ban_reason?: string | null;
        };
        Relationships: [];
      };

      email_codes: {
        Row: {
          id: string;
          user_id: string;
          purpose: string;
          code_hash: string;
          attempts: number;
          expires_at: string;
          used_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          purpose: string;
          code_hash: string;
          attempts?: number;
          expires_at: string;
          used_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          purpose?: string;
          code_hash?: string;
          attempts?: number;
          expires_at?: string;
          used_at?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'email_codes_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };

      user_games: {
        Row: {
          user_id: string;
          game_id: string;
          rank: string | null;
          hours_played: number;
        };
        Insert: {
          user_id: string;
          game_id: string;
          rank?: string | null;
          hours_played?: number;
        };
        Update: {
          user_id?: string;
          game_id?: string;
          rank?: string | null;
          hours_played?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'user_games_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'user_games_game_id_fkey';
            columns: ['game_id'];
            isOneToOne: false;
            referencedRelation: 'games';
            referencedColumns: ['id'];
          },
        ];
      };

      friends: {
        Row: {
          id: string;
          user_a: string;
          user_b: string;
          status: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_a: string;
          user_b: string;
          status?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_a?: string;
          user_b?: string;
          status?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'friends_user_a_fkey';
            columns: ['user_a'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'friends_user_b_fkey';
            columns: ['user_b'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };

      swipes: {
        Row: {
          user_id: string;
          target_user_id: string;
          direction: string;
          created_at: string;
        };
        Insert: {
          user_id: string;
          target_user_id: string;
          direction: string;
          created_at?: string;
        };
        Update: {
          user_id?: string;
          target_user_id?: string;
          direction?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'swipes_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'swipes_target_user_id_fkey';
            columns: ['target_user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };

      match_history: {
        Row: {
          id: string;
          user_a: string;
          user_b: string;
          game_id: string | null;
          mode: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_a: string;
          user_b: string;
          game_id?: string | null;
          mode?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_a?: string;
          user_b?: string;
          game_id?: string | null;
          mode?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'match_history_user_a_fkey';
            columns: ['user_a'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'match_history_user_b_fkey';
            columns: ['user_b'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'match_history_game_id_fkey';
            columns: ['game_id'];
            isOneToOne: false;
            referencedRelation: 'games';
            referencedColumns: ['id'];
          },
        ];
      };

      ratings: {
        Row: {
          id: string;
          match_id: string;
          rater_user_id: string;
          rated_user_id: string;
          rating: number;
          comment: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          match_id: string;
          rater_user_id: string;
          rated_user_id: string;
          rating: number;
          comment?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          match_id?: string;
          rater_user_id?: string;
          rated_user_id?: string;
          rating?: number;
          comment?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'ratings_match_id_fkey';
            columns: ['match_id'];
            isOneToOne: false;
            referencedRelation: 'match_history';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'ratings_rater_user_id_fkey';
            columns: ['rater_user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'ratings_rated_user_id_fkey';
            columns: ['rated_user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };

      calls: {
        Row: {
          id: string;
          initiated_by: string;
          participants: string[];
          mode: string;
          status: string;
          started_at: string;
          ended_at: string | null;
          duration_seconds: number | null;
        };
        Insert: {
          id?: string;
          initiated_by: string;
          participants: string[];
          mode?: string;
          status?: string;
          started_at?: string;
          ended_at?: string | null;
          duration_seconds?: number | null;
        };
        Update: {
          id?: string;
          initiated_by?: string;
          participants?: string[];
          mode?: string;
          status?: string;
          started_at?: string;
          ended_at?: string | null;
          duration_seconds?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: 'calls_initiated_by_fkey';
            columns: ['initiated_by'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };

      conversations: {
        Row: {
          id: string;
          type: string;
          name: string | null;
          created_at: string;
          e2ee_enabled: boolean;
          pinned_message_id: string | null;
        };
        Insert: {
          id?: string;
          type?: string;
          name?: string | null;
          created_at?: string;
          e2ee_enabled?: boolean;
          pinned_message_id?: string | null;
        };
        Update: {
          id?: string;
          type?: string;
          name?: string | null;
          created_at?: string;
          e2ee_enabled?: boolean;
          pinned_message_id?: string | null;
        };
        Relationships: [];
      };

      conversation_members: {
        Row: {
          conversation_id: string;
          user_id: string;
          joined_at: string;
          last_read_at: string | null;
          chat_background: string | null;
          muted: boolean;
          cleared_at: string | null;
        };
        Insert: {
          conversation_id: string;
          user_id: string;
          joined_at?: string;
          last_read_at?: string | null;
          chat_background?: string | null;
          muted?: boolean;
          cleared_at?: string | null;
        };
        Update: {
          conversation_id?: string;
          user_id?: string;
          joined_at?: string;
          last_read_at?: string | null;
          chat_background?: string | null;
          muted?: boolean;
          cleared_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'conversation_members_conversation_id_fkey';
            columns: ['conversation_id'];
            isOneToOne: false;
            referencedRelation: 'conversations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'conversation_members_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };

      messages: {
        Row: {
          id: string;
          conversation_id: string;
          sender_id: string;
          reply_to_id: string | null;
          forwarded_from: string | null;
          text: string | null;
          type: MessageType;
          media_url: string | null;
          duration_seconds: number | null;
          edited_at: string | null;
          deleted_at: string | null;
          preview_title: string | null;
          preview_url: string | null;
          preview_thumbnail: string | null;
          preview_video_id: string | null;
          created_at: string;
          is_encrypted: boolean;
          nonce: string | null;
          sender_public_key: string | null;
        };
        Insert: {
          id?: string;
          conversation_id: string;
          sender_id: string;
          reply_to_id?: string | null;
          forwarded_from?: string | null;
          text?: string | null;
          type?: MessageType;
          media_url?: string | null;
          duration_seconds?: number | null;
          edited_at?: string | null;
          deleted_at?: string | null;
          preview_title?: string | null;
          preview_url?: string | null;
          preview_thumbnail?: string | null;
          preview_video_id?: string | null;
          created_at?: string;
          is_encrypted?: boolean;
          nonce?: string | null;
          sender_public_key?: string | null;
        };
        Update: {
          id?: string;
          conversation_id?: string;
          sender_id?: string;
          reply_to_id?: string | null;
          forwarded_from?: string | null;
          text?: string | null;
          type?: MessageType;
          media_url?: string | null;
          duration_seconds?: number | null;
          edited_at?: string | null;
          deleted_at?: string | null;
          preview_title?: string | null;
          preview_url?: string | null;
          preview_thumbnail?: string | null;
          preview_video_id?: string | null;
          created_at?: string;
          is_encrypted?: boolean;
          nonce?: string | null;
          sender_public_key?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'messages_conversation_id_fkey';
            columns: ['conversation_id'];
            isOneToOne: false;
            referencedRelation: 'conversations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'messages_sender_id_fkey';
            columns: ['sender_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'messages_reply_to_id_fkey';
            columns: ['reply_to_id'];
            isOneToOne: false;
            referencedRelation: 'messages';
            referencedColumns: ['id'];
          },
        ];
      };

      global_messages: {
        Row: {
          id: string;
          sender_id: string;
          text: string | null;
          type: MessageType;
          media_url: string | null;
          duration_seconds: number | null;
          edited_at: string | null;
          deleted_at: string | null;
          preview_title: string | null;
          preview_url: string | null;
          preview_thumbnail: string | null;
          preview_video_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          sender_id: string;
          text?: string | null;
          type?: MessageType;
          media_url?: string | null;
          duration_seconds?: number | null;
          edited_at?: string | null;
          deleted_at?: string | null;
          preview_title?: string | null;
          preview_url?: string | null;
          preview_thumbnail?: string | null;
          preview_video_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          sender_id?: string;
          text?: string | null;
          type?: MessageType;
          media_url?: string | null;
          duration_seconds?: number | null;
          edited_at?: string | null;
          deleted_at?: string | null;
          preview_title?: string | null;
          preview_url?: string | null;
          preview_thumbnail?: string | null;
          preview_video_id?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'global_messages_sender_id_fkey';
            columns: ['sender_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };

      password_resets: {
        Row: {
          id: string;
          user_id: string;
          token_hash: string;
          expires_at: string;
          used_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          token_hash: string;
          expires_at: string;
          used_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          token_hash?: string;
          expires_at?: string;
          used_at?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'password_resets_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };

      tetris_scores: {
        Row: {
          user_id: string;
          best_score: number;
          games_played: number;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          best_score?: number;
          games_played?: number;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          best_score?: number;
          games_played?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'tetris_scores_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: true;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };

      game_scores: {
        Row: {
          user_id: string;
          game: string;
          best_score: number;
          games_played: number;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          game: string;
          best_score?: number;
          games_played?: number;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          game?: string;
          best_score?: number;
          games_played?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'game_scores_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };

      blocks: {
        Row: {
          id: string;
          blocker_id: string;
          blocked_id: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          blocker_id: string;
          blocked_id: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          blocker_id?: string;
          blocked_id?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'blocks_blocker_id_fkey';
            columns: ['blocker_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'blocks_blocked_id_fkey';
            columns: ['blocked_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };

      reports: {
        Row: {
          id: string;
          reporter_id: string;
          reported_id: string;
          reason: string;
          details: string | null;
          context: string | null;
          status: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          reporter_id: string;
          reported_id: string;
          reason: string;
          details?: string | null;
          context?: string | null;
          status?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          reporter_id?: string;
          reported_id?: string;
          reason?: string;
          details?: string | null;
          context?: string | null;
          status?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'reports_reporter_id_fkey';
            columns: ['reporter_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'reports_reported_id_fkey';
            columns: ['reported_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };

      refresh_tokens: {
        Row: {
          id: string;
          user_id: string;
          token_hash: string;
          family_id: string;
          replaced_by: string | null;
          user_agent: string | null;
          ip: string | null;
          revoked_at: string | null;
          expires_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          token_hash: string;
          family_id: string;
          replaced_by?: string | null;
          user_agent?: string | null;
          ip?: string | null;
          revoked_at?: string | null;
          expires_at: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          token_hash?: string;
          family_id?: string;
          replaced_by?: string | null;
          user_agent?: string | null;
          ip?: string | null;
          revoked_at?: string | null;
          expires_at?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'refresh_tokens_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };

      message_reactions: {
        Row: {
          message_id: string;
          user_id: string;
          emoji: string;
          created_at: string;
        };
        Insert: {
          message_id: string;
          user_id: string;
          emoji: string;
          created_at?: string;
        };
        Update: {
          message_id?: string;
          user_id?: string;
          emoji?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'message_reactions_message_id_fkey';
            columns: ['message_id'];
            isOneToOne: false;
            referencedRelation: 'messages';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'message_reactions_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };

      stories: {
        Row: {
          id: string;
          user_id: string;
          image_url: string;
          caption: string | null;
          created_at: string;
          expires_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          image_url: string;
          caption?: string | null;
          created_at?: string;
          expires_at: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          image_url?: string;
          caption?: string | null;
          created_at?: string;
          expires_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'stories_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };

      story_views: {
        Row: {
          story_id: string;
          viewer_id: string;
          created_at: string;
        };
        Insert: {
          story_id: string;
          viewer_id: string;
          created_at?: string;
        };
        Update: {
          story_id?: string;
          viewer_id?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'story_views_story_id_fkey';
            columns: ['story_id'];
            isOneToOne: false;
            referencedRelation: 'stories';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'story_views_viewer_id_fkey';
            columns: ['viewer_id'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };

      servers: {
        Row: {
          id: string;
          owner_id: string;
          name: string;
          icon_emoji: string | null;
          icon_url: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          owner_id: string;
          name: string;
          icon_emoji?: string | null;
          icon_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          owner_id?: string;
          name?: string;
          icon_emoji?: string | null;
          icon_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      server_roles: {
        Row: {
          id: string;
          server_id: string;
          name: string;
          color: string | null;
          permissions: number;
          position: number;
          is_default: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          server_id: string;
          name: string;
          color?: string | null;
          permissions?: number;
          position?: number;
          is_default?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          server_id?: string;
          name?: string;
          color?: string | null;
          permissions?: number;
          position?: number;
          is_default?: boolean;
          created_at?: string;
        };
        Relationships: [];
      };

      server_channels: {
        Row: {
          id: string;
          server_id: string;
          name: string;
          type: string;
          topic: string | null;
          position: number;
          slow_mode_seconds: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          server_id: string;
          name: string;
          type?: string;
          topic?: string | null;
          position?: number;
          slow_mode_seconds?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          server_id?: string;
          name?: string;
          type?: string;
          topic?: string | null;
          position?: number;
          slow_mode_seconds?: number;
          created_at?: string;
        };
        Relationships: [];
      };

      server_members: {
        Row: {
          server_id: string;
          user_id: string;
          nickname: string | null;
          is_banned: boolean;
          joined_at: string;
        };
        Insert: {
          server_id: string;
          user_id: string;
          nickname?: string | null;
          is_banned?: boolean;
          joined_at?: string;
        };
        Update: {
          server_id?: string;
          user_id?: string;
          nickname?: string | null;
          is_banned?: boolean;
          joined_at?: string;
        };
        Relationships: [];
      };

      server_member_roles: {
        Row: {
          server_id: string;
          user_id: string;
          role_id: string;
        };
        Insert: {
          server_id: string;
          user_id: string;
          role_id: string;
        };
        Update: {
          server_id?: string;
          user_id?: string;
          role_id?: string;
        };
        Relationships: [];
      };

      server_messages: {
        Row: {
          id: string;
          channel_id: string;
          sender_id: string;
          content: string | null;
          created_at: string;
          edited_at: string | null;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          channel_id: string;
          sender_id: string;
          content?: string | null;
          created_at?: string;
          edited_at?: string | null;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          channel_id?: string;
          sender_id?: string;
          content?: string | null;
          created_at?: string;
          edited_at?: string | null;
          deleted_at?: string | null;
        };
        Relationships: [];
      };

      server_invites: {
        Row: {
          code: string;
          server_id: string;
          created_by: string;
          max_uses: number | null;
          uses: number;
          expires_at: string | null;
          created_at: string;
        };
        Insert: {
          code: string;
          server_id: string;
          created_by: string;
          max_uses?: number | null;
          uses?: number;
          expires_at?: string | null;
          created_at?: string;
        };
        Update: {
          code?: string;
          server_id?: string;
          created_by?: string;
          max_uses?: number | null;
          uses?: number;
          expires_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      find_direct_conversation: {
        Args: { user_a: string; user_b: string };
        Returns: { id: string; type: string; created_at: string }[];
      };
      increment_call_activity: {
        Args: { p_user_id: string; p_seconds: number };
        Returns: undefined;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
}
