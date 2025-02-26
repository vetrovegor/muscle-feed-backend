import {
    BadRequestException,
    Injectable,
    NotFoundException
} from '@nestjs/common';

import {
    City,
    DaySkipType,
    Menu,
    MenuType,
    Order,
    OrderChangeRequest,
    OrderDay,
    PaymentMethod,
    Prisma
} from '@prisma/client';
import { PrismaService } from '@prisma/prisma.service';

import { AdminOrderRequestDto } from '@admin/order/dto/admin-order-request.dto';
import { CityService } from '@city/city.service';
import { DishService } from '@dish/dish.service';
import { PaginationDto } from '@dto/pagination.dto';
import { MenuService } from '@menu/menu.service';
import { UserService } from '@user/user.service';

import { OrderChangeRequestDto } from './dto/order-change-request.dto';
import { OrderRequestDto } from './dto/order-request.dto';
import { SelectDishDto } from './dto/select-dish.dto';
import { OrderStatus } from './enums/order-status.enum';
import { WeekDay } from './enums/weekday.enum';

@Injectable()
export class OrderService {
    constructor(
        private readonly prismaService: PrismaService,
        private readonly menuService: MenuService,
        private readonly cityService: CityService,
        private readonly userService: UserService,
        private readonly dishService: DishService
    ) {}

    private get paymentMethodRepository() {
        return this.prismaService.paymentMethod;
    }

    private get orderRepository() {
        return this.prismaService.order;
    }

    private get orderDayRepository() {
        return this.prismaService.orderDay;
    }

    private get orderDayDishRepository() {
        return this.prismaService.orderDayDish;
    }

    private get orderChangeRequestRepository() {
        return this.prismaService.orderChangeRequest;
    }

    async getPaymentMethodById(id: number) {
        const paymentMethod = await this.paymentMethodRepository.findFirst({
            where: { id }
        });

        if (!paymentMethod) {
            throw new NotFoundException('Способ оплаты не найден');
        }

        return paymentMethod;
    }

    createPaymentMethodDto(paymentMethod: PaymentMethod) {
        const { id, nameRu, nameHe } = paymentMethod;

        return {
            id,
            name: { ru: nameRu, he: nameHe }
        };
    }

    async getPaymentMethods() {
        const paymentMethodsData =
            await this.paymentMethodRepository.findMany();

        const paymentMethods = paymentMethodsData.map(method =>
            this.createPaymentMethodDto(method)
        );

        return { paymentMethods };
    }

    getInclude() {
        // TODO: извлекать только нужные поля
        return {
            menu: {
                include: { menuType: { select: { backgroundPicture: true } } }
            },
            orderDays: { orderBy: { date: Prisma.SortOrder.asc } },
            paymentMethod: true,
            city: true,
            user: true
        };
    }

    async getById(id: number) {
        const order = await this.orderRepository.findFirst({
            where: { id },
            include: this.getInclude()
        });

        if (!order) {
            throw new NotFoundException('Заказ не найден');
        }

        return order;
    }

    createDto(
        order: Order & { menu: Menu & { menuType: Partial<MenuType> } } & {
            orderDays: OrderDay[];
        } & {
            paymentMethod: PaymentMethod;
        } & { city: City }
    ) {
        const {
            id,
            orderDays,
            createdAt,
            fullName,
            email,
            phone,
            allergies,
            finalPrice,
            city,
            street,
            house,
            floor,
            apartment,
            menu,
            comment,
            skippedWeekdays,
            paymentMethod,
            isPaid
        } = order;

        const notSkippedDays = orderDays.filter(
            orderDay => !orderDay.isSkipped
        );

        const currentDate = new Date();

        const daysLeft = notSkippedDays.filter(
            orderDay => orderDay.date > currentDate
        ).length;

        return {
            id,
            createdAt,
            fullName,
            email,
            phone,
            allergies,
            finalPrice,
            menu: this.menuService.createShortDto(menu),
            city: this.cityService.createDto(city),
            street,
            house,
            floor,
            apartment,
            comment,
            skippedWeekdays,
            daysCount: notSkippedDays.length,
            daysLeft,
            startDate: orderDays[0].date,
            endDate: orderDays[orderDays.length - 1].date,
            paymentMethod: this.createPaymentMethodDto(paymentMethod),
            isPaid
        };
    }

    async createDtoById(id: number) {
        const order = await this.getById(id);

        return { order: this.createDto(order) };
    }

    async create(
        {
            startDate,
            daysCount,
            skippedWeekdays,
            menuId,
            ...rest
        }: OrderRequestDto,
        userId: number | null
    ) {
        // TODO: проверять чтобы дата была не раньше ближайшей даты доставки (вынести дату начала доставки в env)
        if (startDate < new Date()) {
            throw new BadRequestException('Некорректная дата начала заказа');
        }

        await this.cityService.getById(rest.cityId);

        await this.getPaymentMethodById(rest.paymentMethodId);

        const price = await this.menuService.getMenuPriceByDays(
            menuId,
            daysCount
        );

        // // TODO: в будущем определять promocodeDiscount, finalPrice в зависимости от промокода

        const createdOrder = await this.orderRepository.create({
            data: {
                ...rest,
                skippedWeekdays,
                menuId,
                userId,
                price,
                finalPrice: price
            }
        });

        if (menuId != undefined) {
            await this.createOrderPlanByMenu(
                startDate,
                daysCount,
                skippedWeekdays,
                menuId,
                createdOrder.id
            );
        }

        return await this.createDtoById(createdOrder.id);
    }

    private getDaysWithSkipInfo(
        startDate: Date,
        daysCount: number,
        skippedWeekdays: WeekDay[]
    ) {
        const orderDays: { date: Date; isSkipped: boolean }[] = [];
        const currentDate = new Date(startDate);
        let addedDays = 0;

        while (addedDays < daysCount) {
            const currentWeekDay =
                currentDate.getDay() == 0 ? 7 : currentDate.getDay();
            const isSkipped = skippedWeekdays.includes(currentWeekDay);

            orderDays.push({
                date: new Date(currentDate),
                isSkipped
            });

            if (!isSkipped) {
                addedDays++;
            }

            currentDate.setDate(currentDate.getDate() + 1);
        }

        return orderDays;
    }

    private async createOrderPlanByMenu(
        startDate: Date,
        daysCount: number,
        skippedWeekdays: WeekDay[],
        menuId: number,
        orderId: number
    ) {
        const orderDays = this.getDaysWithSkipInfo(
            startDate,
            daysCount,
            skippedWeekdays
        );

        const planData = await this.menuService.getMealPlan(
            menuId,
            startDate,
            orderDays.length
        );

        for (let i = 0; i < orderDays.length; i++) {
            const { date, isSkipped } = orderDays[i];

            const createdOrderDay = await this.orderDayRepository.create({
                data: {
                    orderId,
                    date,
                    isSkipped,
                    daySkipType: isSkipped ? DaySkipType.WEEKDAY_SKIPPED : null
                }
            });

            if (isSkipped) {
                continue;
            }

            for (const { dishTypeId, dish, isPrimary } of planData[i].dishes) {
                await this.orderDayDishRepository.create({
                    data: {
                        orderDayId: createdOrderDay.id,
                        dishTypeId,
                        dishId: dish.id,
                        isSelected: isPrimary
                    }
                });
            }
        }
    }

    private getStatusesConditions() {
        // TODO: возможно придется создавать новую дату через строку вида 2025-10-27
        // при получении getMonth() прибавлять 1
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        today.setTime(today.getTime() - today.getTimezoneOffset() * 60000);

        // TODO: возможно стоит вынести 4 в env
        const expiryDate = new Date(today);
        expiryDate.setDate(today.getDate() + 4);

        return {
            activeCondition: {
                isProcessed: true,
                orderDays: {
                    some: {
                        OR: [
                            { date: today, daySkipType: null },
                            {
                                date: today,
                                daySkipType: DaySkipType.WEEKDAY_SKIPPED
                            }
                        ]
                    }
                }
            },
            frozenCondition: {
                isProcessed: true,
                orderDays: {
                    some: {
                        date: today,
                        daySkipType: DaySkipType.FROZEN
                    }
                }
            },
            unpaidCondition: {
                isProcessed: true,
                isPaid: false
            },
            completedCondition: {
                orderDays: { every: { date: { lt: today } } }
            },
            pendingCondition: {
                isProcessed: true,
                orderDays: { every: { date: { gt: today } } }
            },
            terminatingCondition: {
                isProcessed: true,
                AND: [
                    {
                        orderDays: {
                            some: {
                                date: { gte: today }
                            }
                        }
                    },
                    {
                        orderDays: {
                            every: {
                                date: { lte: expiryDate }
                            }
                        }
                    }
                ]
            },
            unprocessedCondition: { isProcessed: false }
        };
    }

    // TODO: пользователь тоже может запрашивать статистику?
    async getStats() {
        const {
            activeCondition,
            frozenCondition,
            unpaidCondition,
            completedCondition,
            pendingCondition,
            terminatingCondition,
            unprocessedCondition
        } = this.getStatusesConditions();

        const [
            allCount,
            activeCount,
            frozenCount,
            unpaidCount,
            completedCount,
            pendingCount,
            terminatingCount,
            unprocessedCount
        ] = await Promise.all([
            this.orderRepository.aggregate({
                _count: { id: true }
            }),
            this.orderRepository.aggregate({
                _count: { id: true },
                where: activeCondition
            }),
            this.orderRepository.aggregate({
                _count: { id: true },
                where: frozenCondition
            }),
            this.orderRepository.aggregate({
                _count: { id: true },
                where: unpaidCondition
            }),
            this.orderRepository.aggregate({
                _count: { id: true },
                where: completedCondition
            }),
            this.orderRepository.aggregate({
                _count: { id: true },
                where: pendingCondition
            }),
            this.orderRepository.aggregate({
                _count: { id: true },
                where: terminatingCondition
            }),
            this.orderRepository.aggregate({
                _count: { id: true },
                where: unprocessedCondition
            })
        ]);

        return {
            stats: {
                allCount: allCount._count.id,
                activeCount: activeCount._count.id,
                frozenCount: frozenCount._count.id,
                unpaidCount: unpaidCount._count.id,
                completedCount: completedCount._count.id,
                pendingCount: pendingCount._count.id,
                terminatingCount: terminatingCount._count.id,
                unprocessedCount: unprocessedCount._count.id
            }
        };
    }

    async find({
        page,
        limit,
        userId,
        status
    }: {
        page: number;
        limit: number;
        userId?: number;
        status?: OrderStatus;
    }) {
        const {
            activeCondition,
            frozenCondition,
            unpaidCondition,
            completedCondition,
            pendingCondition,
            terminatingCondition,
            unprocessedCondition
        } = this.getStatusesConditions();

        const where = {
            ...(userId != undefined && { userId }),
            ...(status == OrderStatus.ACTIVE && activeCondition),
            ...(status == OrderStatus.FROZEN && frozenCondition),
            ...(status == OrderStatus.UNPAID && unpaidCondition),
            ...(status == OrderStatus.COMPLETED && completedCondition),
            ...(status == OrderStatus.PENDING && pendingCondition),
            ...(status == OrderStatus.TERMINATING && terminatingCondition),
            ...(status == OrderStatus.UNPROCESSED && unprocessedCondition)
        };

        const skip = (page - 1) * limit;

        const ordersData = await this.orderRepository.findMany({
            where,
            include: this.getInclude(),
            orderBy: { createdAt: 'desc' },
            take: limit,
            skip
        });

        const orders = ordersData.map(order => this.createDto(order));

        const totalCount = await this.orderRepository.aggregate({
            _count: { id: true },
            where
        });

        return new PaginationDto(
            'orders',
            orders,
            totalCount._count.id,
            limit,
            page
        );
    }

    async getAdminInfoById(id: number) {
        /* eslint-disable @typescript-eslint/no-unused-vars */
        const {
            userId,
            cityId,
            paymentMethodId,
            menuId,
            user,
            city,
            menu,
            orderDays,
            paymentMethod,
            ...rest
        } = await this.getById(id);
        /* eslint-enable @typescript-eslint/no-unused-vars */

        const notSkippedDays = orderDays.filter(
            orderDay => !orderDay.isSkipped
        );

        const currentDate = new Date();

        const daysLeft = notSkippedDays.filter(
            orderDay => orderDay.date > currentDate
        ).length;

        return {
            order: {
                ...rest,
                user: userId ? this.userService.createDto(user) : null,
                city: this.cityService.createDto(city),
                paymentMethod: this.createPaymentMethodDto(paymentMethod),
                menu: this.menuService.createShortDto(menu),
                daysCount: notSkippedDays.length,
                daysLeft,
                startDate: orderDays[0].date,
                endDate: orderDays[orderDays.length - 1].date
            }
        };
    }

    async adminCreate({
        startDate,
        cityId,
        paymentMethodId,
        userId,
        daysCount,
        skippedWeekdays,
        menuId,
        ...rest
    }: AdminOrderRequestDto) {
        await this.cityService.getById(cityId);

        await this.getPaymentMethodById(paymentMethodId);

        await this.userService.getById(userId);

        await this.menuService.getById(menuId, true);

        const createdOrder = await this.orderRepository.create({
            data: {
                cityId,
                paymentMethodId,
                userId,
                skippedWeekdays,
                menuId,
                ...rest
            }
        });

        if (menuId != undefined) {
            await this.createOrderPlanByMenu(
                startDate,
                daysCount,
                skippedWeekdays,
                menuId,
                createdOrder.id
            );
        }

        return await this.createDtoById(createdOrder.id);
    }

    async update(
        id: number,
        {
            startDate,
            cityId,
            paymentMethodId,
            userId,
            daysCount,
            skippedWeekdays,
            menuId,
            ...rest
        }: AdminOrderRequestDto
    ) {
        const existingOrder = await this.getById(id);

        await this.cityService.getById(cityId);

        await this.getPaymentMethodById(paymentMethodId);

        await this.userService.getById(userId);

        // await this.menuService.getById(menuId, true);

        const updatedOrder = await this.orderRepository.update({
            where: { id },
            data: {
                cityId,
                paymentMethodId,
                userId: userId ?? null,
                // menuId,
                ...rest
            },
            include: this.getInclude()
        });

        // TODO: сделать возможность корректировки дней/даты начала в заказе если переданное dayCount отличается от старого значения

        return { order: this.createDto(updatedOrder) };
    }

    async findOrderDays(id: number, userId?: number) {
        const where = { id, ...(userId != undefined && { userId }) };

        const existingOrder = await this.orderRepository.findFirst({
            where,
            select: {
                orderDays: {
                    select: {
                        id: true,
                        date: true,
                        isSkipped: true,
                        daySkipType: true
                    },
                    orderBy: { date: 'asc' }
                }
            }
        });

        if (!existingOrder) {
            throw new NotFoundException('Заказ не найден');
        }

        return { days: existingOrder.orderDays };
    }

    async getSelectedOrderDayDishes(dayId: number, userId?: number) {
        const where = {
            id: dayId,
            ...(userId != undefined && { order: { userId } })
        };

        const existingOrderDay = await this.orderDayRepository.findFirst({
            where,
            select: {
                orderDayDishes: {
                    where: { isSelected: true },
                    select: { dish: { include: { dishType: true } } },
                    orderBy: { dishTypeId: 'asc' }
                }
            }
        });

        if (!existingOrderDay) {
            throw new NotFoundException('День не найден');
        }

        const dishes = existingOrderDay.orderDayDishes.map(orderDayDish =>
            this.dishService.createDto(orderDayDish.dish)
        );

        const total = this.menuService.calculateTotalNutrients(dishes);

        return { dishes, total };
    }

    async getReplacementOrderDayDishes(
        dayId: number,
        dishTypeId: number,
        userId?: number
    ) {
        const where = {
            id: dayId,
            ...(userId != undefined && { order: { userId } })
        };

        const existingOrderDay = await this.orderDayRepository.findFirst({
            where,
            select: {
                orderDayDishes: {
                    where: { dishTypeId, isSelected: false },
                    select: { dish: { include: { dishType: true } } }
                }
            }
        });

        if (!existingOrderDay) {
            throw new NotFoundException('День не найден');
        }

        const dishes = existingOrderDay.orderDayDishes.map(orderDayDish =>
            this.dishService.createDto(orderDayDish.dish)
        );

        return { dishes };
    }

    async selectDish(
        { dayId, dishTypeId, dishId }: SelectDishDto,
        userId?: number
    ) {
        const where = {
            dishTypeId,
            dishId,
            orderDay: {
                id: dayId,
                ...(userId != undefined && { order: { userId } })
            }
        };

        const existingOrderDish = await this.orderDayDishRepository.findFirst({
            where,
            select: { isSelected: true, dish: { include: { dishType: true } } }
        });

        if (!existingOrderDish) {
            throw new NotFoundException('Блюдо не найдено');
        }

        if (!existingOrderDish.isSelected) {
            await this.orderDayDishRepository.updateMany({
                where: {
                    dishTypeId,
                    isSelected: true,
                    orderDay: { id: dayId }
                },
                data: {
                    isSelected: false
                }
            });

            await this.orderDayDishRepository.updateMany({
                where: {
                    dishTypeId,
                    dishId,
                    orderDay: { id: dayId }
                },
                data: {
                    isSelected: true
                }
            });
        }

        return { dish: this.dishService.createDto(existingOrderDish.dish) };
    }

    createChangeRequestDto(
        orderChangeRequest: OrderChangeRequest & {
            order: Order & { menu: Menu & { menuType: Partial<MenuType> } } & {
                orderDays: OrderDay[];
            } & {
                paymentMethod: PaymentMethod;
            } & { city: City };
        }
    ) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { orderId, order, ...rest } = orderChangeRequest;

        return { ...rest, order: this.createDto(order) };
    }

    async createChangeRequest(
        id: number,
        userId: number,
        dto: OrderChangeRequestDto
    ) {
        const existingOrder = await this.orderRepository.findFirst({
            where: { id, userId },
            select: { id: true }
        });

        if (!existingOrder) {
            throw new NotFoundException('Заказ не найден');
        }

        const createdChangeRequest =
            await this.orderChangeRequestRepository.create({
                data: { ...dto, orderId: id },
                include: { order: { include: this.getInclude() } }
            });

        return { order: this.createChangeRequestDto(createdChangeRequest) };
    }
}
