/*
    FatakForecast Crossing Event Engine

    Calculates when a train is expected to PASS
    a railway crossing.

    Important:
    The crossing itself is the target event.

    A nearby station can be used as an anchor:

    APPROACHING STATION:
        station arrival
        -
        crossing → station travel time
        =
        crossing passage

    LEAVING STATION:
        station departure
        +
        station → crossing travel time
        =
        crossing passage
*/


function calculateTravelMinutes(
    distanceKm,
    speedKmph
) {

    if (
        distanceKm == null ||
        speedKmph == null ||
        distanceKm < 0 ||
        speedKmph <= 0
    ) {
        return null;
    }

    return (
        distanceKm / speedKmph
    ) * 60;
}


/*
    Determine whether the train is before
    or after the station/crossing.
*/
function determineDirection(
    trainPositionKm,
    crossingPositionKm
) {

    if (
        trainPositionKm == null ||
        crossingPositionKm == null
    ) {
        return "unknown";
    }

    if (
        trainPositionKm < crossingPositionKm
    ) {
        return "approaching";
    }

    if (
        trainPositionKm > crossingPositionKm
    ) {
        return "passed";
    }

    return "at-crossing";
}


/*
    Calculate crossing passage time using
    a nearby station as an anchor.

    direction:

        approaching
            station arrival - travel time

        leaving
            station departure + travel time
*/
function calculateCrossingPassageTime({
    stationArrival,
    stationDeparture,
    crossingDistanceFromStationKm,
    speedKmph,
    direction
}) {

    if (
        crossingDistanceFromStationKm == null ||
        speedKmph == null ||
        speedKmph <= 0
    ) {
        return null;
    }


    const travelMinutes =
        calculateTravelMinutes(
            crossingDistanceFromStationKm,
            speedKmph
        );


    if (travelMinutes == null) {
        return null;
    }


    if (direction === "approaching") {

        if (!stationArrival) {
            return null;
        }

        const stationTime =
            new Date(stationArrival);

        return new Date(
            stationTime.getTime() -
            travelMinutes * 60 * 1000
        );

    }


    if (direction === "leaving") {

        if (!stationDeparture) {
            return null;
        }

        const stationTime =
            new Date(stationDeparture);

        return new Date(
            stationTime.getTime() +
            travelMinutes * 60 * 1000
        );

    }


    return null;
}


module.exports = {

    calculateTravelMinutes,

    determineDirection,

    calculateCrossingPassageTime

};