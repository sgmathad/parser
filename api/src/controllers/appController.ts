import { NextFunction, Request, Response } from 'express';
import {
  S3Client,
  GetObjectCommand,
  GetObjectCommandInput,
  DeleteObjectCommand,
  DeleteObjectCommandInput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  conversationalRetrievelQA,
  guardRailChain,
  stream,
} from '../utils/langchainConfig';
import {
  countUploadsbyUserId,
  deleteUploadById,
  getUploadById,
  getStatsById,
  insertUpload,
  selectUploads,
} from '../models/uploadModel';
import { AppError, catchAsync } from '../utils';
import { redisClient, redisPub } from '../db';
import {
  getConversationById,
  insertConversation,
} from '../models/conversationModel';

// create a s3 client with the
// region and credentials.
const s3 = new S3Client({
  region: process.env.AWS_REGION!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY!,
    secretAccessKey: process.env.AWS_SECRET_KEY!,
  },
});

const getConversationKey = (id: string): string => {
  return `conversation:${id}`;
};

/**
 * @returns A response that the user is logged In along with user
 * info. Errors are thrown by the protect controller. Check authController
 * for more detail.
 */
export const getMe = catchAsync(async (req: Request, res: Response) => {
  // this retrieves only the email, firstName, and lastName
  // to send back to frontend or use it any where needed.
  const { email, firstName, lastName, id } = req.user;
  res.status(200).json({
    status: 'success',
    user: {
      email,
      firstName,
      lastName,
      id,
    },
    message: 'Authenticated!!',
  });
});

/**
 * Method to get the statistics used in the
 * homepage of the app, i.e count, active and
 * processing documents
 */
export const getUploadStatsById = catchAsync(
  async (req: Request, res: Response) => {
    const { user_id } = req.params;
    const stats = await getStatsById(user_id as string);
    res.status(200).json({
      status: 'success',
      stats,
    });
  },
);

/**
 * Method to upload a record to uploads table with
 * filename and status as processing. Later publish
 * the event to worker. File is uploaded by multer.
 */
export const uploadFile = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    // get the file name.
    const file = req.file;

    // 1. If there is no file, return error.
    if (!file) {
      return next(new AppError('No file uploaded. Please attach a file.', 400));
    }

    // get user details for sending email.
    const { email, firstName, lastName } = req.user;

    // Set the filename, used format: <user_id>_<current_date>_<filename>.
    const fileName = file.filename;
    const path = file.path;

    // Insert the filename into uploads table
    const upload = await insertUpload(
      req.user.id,
      fileName,
      req.file?.originalname!,
    );

    // upload_key format to publish event: upload:<unique_id_in_db>
    const upload_key = `upload:${upload.id}`;

    // store all the details of a file in redis hash
    await redisClient.hSet(upload_key, {
      fileName,
      path,
      mimetype: file.mimetype,
      email,
      firstName,
      lastName,
      originalName: req.file?.originalname!,
    });

    // Expire the key if the worker doesn't pick
    // it up.
    await redisClient.expire(upload_key, 300);

    // publish the event for redis to pick up.
    await redisPub.publish('processFile', upload_key);

    // return a succesful response.
    res.status(200).json({
      status: 'success',
      message:
        'Your request has been received and is being processed. You will be notified once it is complete.',
    });
  },
);

/**
 * This method is to get the uploads
 * from the database and return it back
 * to the users.
 */
export const getUploads = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    // Get the user id from the request.
    const user_id = req.user.id;
    // get the search name if present in the query.
    let searchQuery = '';
    if (req.query.search && typeof req.query.search === 'string')
      searchQuery = req.query.search;

    // get all uploads.
    const uploads = await selectUploads(user_id, searchQuery);

    // count the number of uploads created by the user.
    const countUploads = await countUploadsbyUserId(user_id);

    res.status(200).json({
      status: 'success',
      message: 'Succesfull',
      uploads,
      ...countUploads,
    });
  },
);

/**
 * Method to get the url from the s3 bucket
 * to serve the user. Id is needed.
 */
export const getUploadPdfUrl = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    // 1. get the id from the url
    const { id } = req.params;

    // 2. Find an upload if present.
    const upload = await getUploadById(id as string);

    // 3. if there is no upload or the id was deleted
    // return back.
    if (upload === undefined) {
      return next(new AppError('No file exists', 400));
    }

    const filename = upload.file_name;

    // s3 command options.
    const getOptions: GetObjectCommandInput = {
      Bucket: process.env.AWS_BUCKET!,
      Key: filename,
    };

    // 4. Get the url with getSignedUrl.
    const url = await getSignedUrl(s3, new GetObjectCommand(getOptions), {
      expiresIn: 300,
    });

    // 5. store the result as getting conversations are pending.
    (req as any).url = url;
    (req as any).original_name = upload.original_name;

    // 6. send next.
    next();
  },
);

/**
 * Helper method to get conversations into redis sever from postgres
 * for faster access.
 * @param conversationKey Conversation key to check in the redis db.
 * @param id Id of the upload if in case redis data is expired.
 * @returns
 */
const getConversationByKey = async (conversationKey: string, id: string) => {
  // check if the covnersation for an upload exists.
  if (!(await redisClient.exists(conversationKey))) {
    // if not get the conversations from the db.
    const history = await getConversationById(id);

    if (history !== undefined && history.length !== 0) {
      // stringify the object to store.
      const serialized = history.map((el: any) => JSON.stringify(el));
      // store array of objects in redis.
      await redisClient.rPush(conversationKey, serialized);
    }
  }
  // return the parse objects back.
  return (await redisClient.lRange(conversationKey, 0, -1)).map((el) =>
    JSON.parse(el),
  );
};

/**
 * Method to get the chat history from the database.
 */
export const getConversations = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    // get the id from the url
    const { id } = req.params;
    // get conversation key, ex: conversation:id
    const conversationKey = getConversationKey(id as string);
    // get conversations.
    const history = await getConversationByKey(conversationKey, id as string);
    res.status(200).json({
      status: 'success',
      history,
      url: (req as any).url,
      originalName: (req as any).original_name,
    });
  },
);

/**
 * Method to stream response from llm to the frontend.
 * A single question is taken and converted into a statndalone
 * question along with the chat history using langchain.
 * This question is later sent to the llm along with the context.
 */
export const requestLLM = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    // Important to send streams to the frontend.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Connection', 'keep-alive');

    // get query from the user.
    const { query } = req.body;
    // get id from url.
    const { id } = req.params;

    // check for personal information or prompt injection.
    const guardRailResult = (await guardRailChain.invoke({
      question: query,
    })) as { sensitive: boolean; promptInjection: boolean };

    if (guardRailResult.sensitive || guardRailResult.promptInjection) {
      const guardRailResponse = {
        event: 'token',
        token:
          'Your request could not be processed due to security restrictions.',
      };

      res.write(JSON.stringify(guardRailResponse) + '\n');
      res.end();
      return;
    }

    // get the conversations.
    const conversationKey = getConversationKey(id as string);
    let chatHistory = await getConversationByKey(conversationKey, id as string);

    // retreive context and standalone data.
    const response = await conversationalRetrievelQA.invoke({
      question: query,
      chatHistory,
      uploadId: id,
    });

    // send the running context for user to view.
    res.write(
      JSON.stringify({
        event: 'runningQuestion',
        runningQuestion: response.output.question,
      }) + '\n',
    );

    // stream response to the user. Sending
    // of response is handled inside. The message
    // is stored to store in the db.
    const aiMessage = await stream(res, response.output);

    // This part is to return the pages from
    // which the contents were taken.

    // Use of set to avoid duplicates
    const uniquePageNumbers = new Set();
    // using an empty array to maintain order.
    const pageNumbers = [];
    const context: any = response.output.context;
    const running_context: string = response.output.question;

    // add page numbers into the array.
    for (let i = 0; i < context.length; i++) {
      const page = context[i].page_number;
      if (!uniquePageNumbers.has(page)) {
        pageNumbers.push(page);
        uniquePageNumbers.add(page);
      }
    }

    // creating an object, since streams
    // need strings and this object is sent in
    // the same stream, tokens are sent.
    const pageResponse = {
      event: 'pageNumber',
      pageNumbers,
    };

    // Write the pageNumbers,
    res.write(JSON.stringify(pageResponse) + '\n'); // \n is important if there are multiple objects.
    // end the stream.

    //update redis for faster retrieval access.
    const messages = [
      JSON.stringify({ message: query, type: 'human' }),
      JSON.stringify({
        message: aiMessage,
        type: 'ai',
        pageNumbers,
        runningQuestion: running_context,
      }),
    ];
    await redisClient.rPush(conversationKey, messages);
    await redisClient.expire(conversationKey, 300);

    // store both the human messages in the database.
    // First store the human message.
    await insertConversation(id as string, query, 'human');

    // second store the ai message.
    await insertConversation(
      id as string,
      aiMessage,
      'ai',
      pageNumbers,
      running_context,
    );

    // end the stream
    res.end();
  },
);

/**
 * Method to delete a particular Upload from the id
 */
export const deleteById = catchAsync(
  async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;

    // 2. Find an upload if present.
    const upload = await getUploadById(id as string);

    // 3. if there is no upload or the id was deleted
    // return back.
    if (upload === undefined) {
      return next(new AppError('No file exists', 400));
    }

    const filename = upload.file_name;

    // 4. Delete it from the s3 bucket.
    const deleteOptions: DeleteObjectCommandInput = {
      Bucket: process.env.AWS_BUCKET!,
      Key: filename,
    };

    await s3.send(new DeleteObjectCommand(deleteOptions));

    // 5. Delete it from the database
    const response = await deleteUploadById(id as string);

    res.status(200).json({
      status: 'success',
      message: `${upload.original_name} successfully deleted.`,
    });
  },
);
