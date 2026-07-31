import {
  DataTypes,
  Model,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from "sequelize";
import { sequelize } from "@/lib/sequelize";
import { Post } from "./post.schema";

export class Reply extends Model<
  InferAttributes<Reply>,
  InferCreationAttributes<Reply>
> {
  declare id: CreationOptional<number>;
  declare vk_post_id: number | null; // references Post.vk_id (targetKey)
  declare vk_reply_id: number | null;
  declare vk_author_id: number | null;
  declare tg_reply_id: number | null;
  // Plain indexed column used for discussion-thread lookups. NOT a foreign key
  // (see association note below — the legacy dual-FK caused constraint storms).
  declare discussion_tg_id: number | null;
  declare tg_author_id: number | null;
  declare created_at: Date | null;
  declare attachments: unknown | null;
}

Reply.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    vk_post_id: { type: DataTypes.INTEGER, allowNull: true },
    vk_reply_id: { type: DataTypes.INTEGER, allowNull: true, unique: true },
    vk_author_id: { type: DataTypes.INTEGER, allowNull: true },
    tg_reply_id: { type: DataTypes.INTEGER, allowNull: true, unique: true },
    discussion_tg_id: { type: DataTypes.INTEGER, allowNull: true },
    tg_author_id: { type: DataTypes.INTEGER, allowNull: true },
    created_at: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: DataTypes.NOW,
    },
    attachments: { type: DataTypes.JSON, allowNull: true },
  },
  {
    sequelize,
    tableName: "replies",
    timestamps: false,
    indexes: [
      { name: "idx_replies_vk_post_id", fields: ["vk_post_id"] },
      { name: "idx_replies_discussion_tg_id", fields: ["discussion_tg_id"] },
    ],
  },
);

// Replies link to Posts by the IMMUTABLE key vk_post_id -> Post.vk_id, cascading
// on delete. The legacy schema ALSO declared a foreign key on discussion_tg_id;
// that column is nullable and only filled later by the auto-forward handler, so
// enforcing it as an FK caused SQLITE_CONSTRAINT failures whenever the linkage
// was stale or raced (see rewrite log analysis, P0-2). It is now a plain indexed
// lookup column — no FK.
Post.hasMany(Reply, {
  as: "repliesByVkPost",
  foreignKey: "vk_post_id",
  sourceKey: "vk_id",
  onDelete: "CASCADE",
  onUpdate: "CASCADE",
});
Reply.belongsTo(Post, {
  as: "postByVkPost",
  foreignKey: "vk_post_id",
  targetKey: "vk_id",
  onDelete: "CASCADE",
  onUpdate: "CASCADE",
});
