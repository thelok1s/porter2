import {
  DataTypes,
  Model,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from "sequelize";
import { sequelize } from "@/lib/sequelize";

/**
 * Submission status enum
 */
export enum SubmissionStatus {
  PENDING = "pending",
  APPROVED = "approved",
  MANUAL = "manual",
  DECLINED = "declined",
  SCHEDULED = "scheduled",
  PUBLISHED = "published",
}

/**
 * Submission model for content moderation workflow
 * Stores user submissions (that require approval) from external services
 */
export class Submission extends Model<
  InferAttributes<Submission>,
  InferCreationAttributes<Submission>
> {
  declare id: CreationOptional<number>;

  /** Telegram user ID of the author */
  declare author_tg_id: string;

  /** Author's display name */
  declare author_name: string;

  /** Submission text content */
  declare text: string;

  /** Image URL or base64 data */
  declare image: string | null;

  /** Additional metadata as JSON (e.g., form data, game details) */
  declare metadata: object | null;

  /** Current status of the submission */
  declare status: SubmissionStatus;

  /** Telegram message ID of the moderation message */
  declare moderation_message_id: number | null;

  /** Telegram chat ID where moderation message was sent */
  declare moderation_chat_id: string | null;

  /** Scheduled publish date (Unix timestamp) */
  declare scheduled_at: number | null;

  /** VK post ID after publishing */
  declare vk_post_id: number | null;

  /** Telegram message ID after publishing */
  declare tg_message_id: number | null;

  /** ID of moderator who processed the submission */
  declare moderator_tg_id: string | null;

  /** Moderator's display name */
  declare moderator_name: string | null;

  /** Reason for decline (if declined) */
  declare decline_reason: string | null;

  /** Created timestamp */
  declare created_at: CreationOptional<Date>;

  /** Updated timestamp */
  declare updated_at: CreationOptional<Date>;
}

Submission.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    author_tg_id: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    author_name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    text: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    image: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    metadata: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM(...Object.values(SubmissionStatus)),
      allowNull: false,
      defaultValue: SubmissionStatus.PENDING,
    },
    moderation_message_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    moderation_chat_id: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    scheduled_at: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    vk_post_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    tg_message_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    moderator_tg_id: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    moderator_name: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    decline_reason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: "submissions",
    timestamps: true,
    underscored: true,
    indexes: [
      { name: "idx_submissions_status", fields: ["status"] },
      { name: "idx_submissions_author", fields: ["author_tg_id"] },
      {
        name: "idx_submissions_moderation_msg",
        fields: ["moderation_message_id"],
      },
      { name: "idx_submissions_scheduled", fields: ["scheduled_at"] },
    ],
  },
);
