import { Controller, Get } from '@nestjs/common';

import { Public } from '@auth/decorators';

import { CityService } from './city.service';

@Public()
@Controller('city')
export class CityController {
    constructor(private readonly cityService: CityService) {}

    @Get()
    async find() {
        return await this.cityService.find();
    }
}
