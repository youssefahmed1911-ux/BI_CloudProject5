import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── AWS Clients (uses EC2 instance role automatically – no keys needed) ──
const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });

const dynamo = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" })
);

// ── Profile type ──
interface Profile {
  id: string;
  name: string;
  age: number;
  position: string;
  imageUrl: string;
  createdAt: string;
}

// ── Upload to S3 ──
async function uploadToS3(file: Express.Multer.File): Promise<string> {
  const ext = path.extname(file.originalname);
  const key = `uploads/${uuidv4()}${ext}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME!,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
    })
  );

  return `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
}

// ── Save profile to DynamoDB ──
async function saveProfile(profile: Profile): Promise<void> {
  await dynamo.send(
    new PutCommand({
      TableName: process.env.DYNAMODB_TABLE || "UserUploads",
      Item: profile,
    })
  );
}

// ── Get all profiles from DynamoDB ──
async function getAllProfiles(): Promise<Profile[]> {
  const result = await dynamo.send(
    new ScanCommand({
      TableName: process.env.DYNAMODB_TABLE || "UserUploads",
    })
  );
  return (result.Items as Profile[]) || [];
}

// ── Express server ──
async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || "3000");

  app.use(cors());
  app.use(express.json());

  // multer uses memory storage – file goes straight to S3, not to disk
  const upload = multer({ storage: multer.memoryStorage() });

  // GET all profiles
  app.get("/api/profiles", async (req, res) => {
    try {
      const profiles = await getAllProfiles();
      res.json(profiles);
    } catch (error) {
      console.error("Error fetching profiles:", error);
      res.status(500).json({ error: "Failed to fetch profiles" });
    }
  });

  // POST create profile → upload image to S3 → save metadata to DynamoDB
  app.post("/api/profiles", upload.single("image"), async (req, res) => {
    try {
      const { name, age, position } = req.body;
      const file = req.file;

      if (!file) {
        return res.status(400).json({ error: "Image is required" });
      }

      // 1. Upload image to S3
      const imageUrl = await uploadToS3(file);

      // 2. Build profile object
      const newProfile: Profile = {
        id: uuidv4(),
        name,
        age: parseInt(age),
        position,
        imageUrl,  // S3 public URL
        createdAt: new Date().toISOString(),
      };

      // 3. Save to DynamoDB
      await saveProfile(newProfile);

      res.status(201).json(newProfile);
    } catch (error) {
      console.error("Error creating profile:", error);
      res.status(500).json({ error: "Failed to create profile" });
    }
  });

  // ── Vite Middleware ──
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
