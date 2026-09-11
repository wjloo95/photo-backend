import { ErrorRequestHandler } from 'express'

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {

    // If Production
    // If Dev 

    const errorMessage = 'Not Found'

    if(err.statusCode >= 400 && err.statusCode < 500){
        console.log(err.message);

    }



    return {error: errorMessage}
    

}